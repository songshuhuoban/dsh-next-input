import type { Context, Volatile } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection';
import type { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/cordis-plugin-loader';
import z from '@deepseek-ai/schemastery';
import { generateSuggestion, type LlmStreamPort } from './generation.js';
import { createContextPreparer } from './context.js';
import { DEFAULT_CONFIG, RPC_ENDPOINT, type NextInputConfig, type SuggestionRequest, type SuggestionResponse } from './protocol.js';

export const name = 'next-input';
export const inject = ['agents', 'llm', 'connection'];

/** Config references integrate directly with the Harness 0.1.7 SettingsForms. */
export const Config = z.object({
  enabled: z.boolean().default(DEFAULT_CONFIG.enabled).description('Suggest the next reply when the assistant finishes.').volatile(),
  maxRetries: z.number().step(1).min(0).max(10).default(DEFAULT_CONFIG.maxRetries).description('Additional attempts after a failed suggestion request.').volatile(),
  timeoutMs: z.number().step(1).min(1_000).max(120_000).default(DEFAULT_CONFIG.timeoutMs).description('Timeout of each suggestion attempt, in milliseconds.').volatile(),
  maxSuggestionChars: z.number().step(1).min(16).max(1_000).default(DEFAULT_CONFIG.maxSuggestionChars).description('Maximum length of a suggested reply.').volatile(),
});
export type Config = { [Key in keyof NextInputConfig]: Volatile<NextInputConfig[Key]> };

export interface HostPorts {
  agents: { get(id: SessionId): Agent | undefined; roots(): Agent[] };
  llm: LlmStreamPort;
}

type ActiveSuggestion = { agent: Agent; abort: AbortController };

/** Reject malformed identities and stamps before looking up session state. */
export function parseSuggestionRequest(value: unknown): SuggestionRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 4 || Object.keys(record).some(key => !['sessionId', 'roundId', 'requestId', 'requestedAt'].includes(key))) return;
  if (typeof record.sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(record.sessionId)) return;
  if (typeof record.roundId !== 'string' || !/^(0|[1-9]\d{0,15})$/u.test(record.roundId) || !Number.isSafeInteger(Number(record.roundId))) return;
  if (typeof record.requestId !== 'number' || !Number.isSafeInteger(record.requestId) || record.requestId < 1) return;
  if (typeof record.requestedAt !== 'number' || !Number.isSafeInteger(record.requestedAt) || record.requestedAt < 0) return;
  return { sessionId: record.sessionId, roundId: record.roundId, requestId: record.requestId, requestedAt: record.requestedAt };
}

/** The newest completed turn; a later open/failed turn makes an older suggestion ineligible. */
export function latestCompletedRound(agent: Agent): string | undefined {
  const events = agent.session.snapshotEvents();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event.type === 'turn/start') return;
    if (event.type === 'turn/end') return event.data.reason.kind === 'completed' ? String(event.seq) : undefined;
  }
}

function failure(): ConnectionRpcResult<SuggestionResponse> {
  // The client retries this generic result; provider diagnostics never enter the UI.
  return { ok: false, error: { code: 'next-input/unavailable', message: 'Suggestion unavailable', details: {} } };
}

/** Separate domain state from the Connection envelope and Cordis effect lifecycle. */
export function createSuggestionHost(ports: HostPorts, config: () => NextInputConfig) {
  const active = new Set<ActiveSuggestion>();
  let closed = false;
  let revision = 0;
  let contexts = new WeakMap<Agent, ReturnType<typeof createContextPreparer>>();
  const nullResult = (request: SuggestionRequest): ConnectionRpcResult<SuggestionResponse> => ({
    ok: true, value: { ...request, suggestion: null, generatedAt: Date.now() },
  });
  function eligible(request: SuggestionRequest, expected?: Agent): Agent | undefined {
    if (closed || !config().enabled) return;
    const agent = ports.agents.get(request.sessionId as SessionId);
    if (!agent || (expected && agent !== expected) || agent.id !== request.sessionId || agent.session.id !== request.sessionId) return;
    if (!ports.agents.roots().includes(agent) || agent.session.header.origin === 'subagent') return;
    if (agent.status !== 'idle' || agent.inbox.nextTurn.length !== 0 || agent.inbox.nextStep.length !== 0) return;
    return latestCompletedRound(agent) === request.roundId ? agent : undefined;
  }
  return {
    async suggest(value: unknown, signal: AbortSignal): Promise<ConnectionRpcResult<SuggestionResponse>> {
      const request = parseSuggestionRequest(value);
      if (!request) return failure();
      const agent = eligible(request);
      if (!agent || signal.aborted) return nullResult(request);
      const policy = { ...config() };
      const capturedRevision = revision;
      const abort = new AbortController();
      const operation = { agent, abort };
      const combined = AbortSignal.any([signal, abort.signal]);
      const timeout = setTimeout(() => abort.abort('timeout'), policy.timeoutMs);
      active.add(operation);
      try {
        const route = agent.session.requestHeader()?.config;
        if (!route?.provider || !route.model) return nullResult(request);
        let context = contexts.get(agent);
        if (!context) { context = createContextPreparer(); contexts.set(agent, context); }
        const prepared = await context.prepare({ llm: ports.llm, route, messages: agent.session.deriveMessages(), signal: combined });
        if (combined.aborted || revision !== capturedRevision || !eligible(request, agent)) return nullResult(request);
        const suggestion = await generateSuggestion({ llm: ports.llm, route,
          summary: prepared.summary, transcript: prepared.recent, maxSuggestionChars: policy.maxSuggestionChars, signal: combined });
        if (combined.aborted || revision !== capturedRevision || !eligible(request, agent)) return nullResult(request);
        return { ok: true, value: { ...request, suggestion, generatedAt: Date.now() } };
      } catch {
        // Invalidated generations are terminal; only an unchanged attempt may be retried.
        if (signal.aborted || (abort.signal.aborted && abort.signal.reason !== 'timeout') || revision !== capturedRevision || !eligible(request, agent)) return nullResult(request);
        return failure();
      } finally {
        clearTimeout(timeout);
        active.delete(operation);
      }
    },
    invalidate(agent?: Agent) {
      if (agent === undefined) { revision++; contexts = new WeakMap(); }
      for (const operation of active) if (agent === undefined || operation.agent === agent) operation.abort.abort('invalidated');
    },
    forget(agent: Agent) {
      contexts.get(agent)?.clear();
      contexts.delete(agent);
      for (const operation of active) if (operation.agent === agent) operation.abort.abort('disposed');
    },
    dispose() {
      closed = true;
      revision++;
      contexts = new WeakMap();
      for (const operation of active) operation.abort.abort('disposed');
    },
  };
}

export function apply(ctx: Context, refs: Config): void {
  const config = (): NextInputConfig => ({ enabled: refs.enabled.get(), maxRetries: refs.maxRetries.get(),
    timeoutMs: refs.timeoutMs.get(), maxSuggestionChars: refs.maxSuggestionChars.get() });
  const host = createSuggestionHost({ agents: ctx.agents, llm: ctx.llm }, config);
  ctx.effect(() => () => host.dispose());
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'running') host.invalidate(agent); });
  ctx.on('agent/inbox/inserted', ({ agent }) => host.invalidate(agent));
  ctx.on('agent/disposed', ({ agent }) => host.forget(agent));
  // Config snapshots have committed before this owner-scoped Loader notification.
  ctx.on('loader/volatile-update', () => host.invalidate());
  // Gateway owns the sole /api RPC interceptor. An exact Connection Fetch route
  // takes precedence and preserves the public RPC envelope on every carrier.
  ctx.connection.fetch.register({
    path: `/api/${RPC_ENDPOINT}`, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response(null, { status: 415 });
        const parsed = clientRequestSchema.safeParse(await request.json());
        if (!parsed.success || parsed.data.method !== RPC_ENDPOINT) return new Response(null, { status: 400 });
        const result = await host.suggest(parsed.data.payload, request.signal);
        return Response.json({ type: 'server-response', rpcId: parsed.data.rpcId, result }, { headers: { 'cache-control': 'no-store' } });
      } catch {
        return new Response(null, { status: 400 });
      }
    },
  });
}
