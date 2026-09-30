import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent';
import { createAssistantMessage, createUserMessage, type GenerateOptions, type LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { HostConnectionService, type ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection';
import { Config, apply, createSuggestionHost, inject, name, parseSuggestionRequest, type HostPorts } from '../src/index.js';
import { DEFAULT_CONFIG, RPC_ENDPOINT, type NextInputConfig, type SuggestionRequest } from '../src/protocol.js';

const request: SuggestionRequest = { sessionId: 'session-1', roundId: '20', requestId: 1, requestedAt: 100 };
const signal = () => new AbortController().signal;
function setup(stream?: (options: GenerateOptions) => AsyncIterable<StreamChunk>) {
  const state = { status: 'idle', origin: 'human', roots: true, live: true, pending: 0,
    events: [{ type: 'turn/end', seq: 20, data: { reason: { kind: 'completed' } } }] };
  const calls: GenerateOptions[] = [];
  const agent = {
    id: 'session-1', get status() { return state.status; },
    inbox: { get nextTurn() { return Array(state.pending).fill({}); }, nextStep: [] },
    session: { id: 'session-1', header: { get origin() { return state.origin; } }, snapshotEvents: () => state.events,
      requestHeader: () => ({ config: { provider: 'session-provider', model: 'session-model' } }),
      deriveMessages: () => [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '请检查' }] },
        { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '需要运行测试吗？' }] }],
    },
  } as unknown as Agent;
  const ports: HostPorts = {
    agents: { get: () => state.live ? agent : undefined, roots: () => state.roots ? [agent] : [] },
    llm: { async *stream(options) {
      calls.push(options);
      if (stream) yield* stream(options);
      else { yield { type: 'text-delta', index: 0, text: '请运行测试。' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
    } },
  };
  const policy: NextInputConfig = { ...DEFAULT_CONFIG };
  return { state, agent, ports, calls, policy, host: createSuggestionHost(ports, () => policy) };
}

test('valid stamps are detached and malformed payloads never reach generation', async () => {
  assert.deepEqual(parseSuggestionRequest(request), request);
  assert.notEqual(parseSuggestionRequest(request), request);
  const invalid = [null, [], { ...request, sessionId: '../session' }, { ...request, roundId: '020' },
    { ...request, roundId: '9007199254740992' }, { ...request, requestId: 0 }, { ...request, requestedAt: NaN },
    { ...request, extra: true }, { ...request, requestId: Number.MAX_SAFE_INTEGER + 1 }];
  const { host, calls } = setup();
  for (const value of invalid) assert.equal((await host.suggest(value, signal())).ok, false);
  assert.equal(calls.length, 0);
});

test('successful suggestion echoes immutable per-request ordering metadata and uses the session model', async () => {
  const { host, calls } = setup();
  const result = await host.suggest(request, signal());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual({ ...result.value, generatedAt: 0 }, { ...request, suggestion: '请运行测试。', generatedAt: 0 });
  assert.equal(calls[0].provider, 'session-provider');
  assert.equal(calls[0].model, 'session-model');
});

test('busy, queued, stale, failed, child and detached sessions produce no model call', async () => {
  for (const mutate of [
    (fixture: ReturnType<typeof setup>) => { fixture.policy.enabled = false; },
    (fixture: ReturnType<typeof setup>) => { fixture.state.status = 'running'; },
    (fixture: ReturnType<typeof setup>) => { fixture.state.pending = 1; },
    (fixture: ReturnType<typeof setup>) => { fixture.state.events[0].seq = 21; },
    (fixture: ReturnType<typeof setup>) => { fixture.state.events[0].data.reason.kind = 'error'; },
    (fixture: ReturnType<typeof setup>) => { fixture.state.origin = 'subagent'; },
    (fixture: ReturnType<typeof setup>) => { fixture.state.roots = false; },
    (fixture: ReturnType<typeof setup>) => { fixture.state.live = false; },
    (fixture: ReturnType<typeof setup>) => { fixture.state.events.push({ type: 'turn/start', seq: 21, data: { reason: { kind: 'running' } } }); },
  ]) {
    const fixture = setup();
    mutate(fixture);
    const result = await fixture.host.suggest(request, signal());
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.suggestion, null);
    assert.equal(fixture.calls.length, 0);
  }
});

test('new turn, config change, disposal, and caller abort invalidate an in-flight suggestion', async () => {
  for (const invalidate of ['turn', 'config', 'dispose', 'caller']) {
    let resolve!: () => void;
    const wait = new Promise<void>(done => { resolve = done; });
    const fixture = setup(async function* () {
      await wait;
      yield { type: 'text-delta', index: 0, text: 'obsolete' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    });
    const abort = new AbortController();
    const pending = fixture.host.suggest(request, abort.signal);
    await new Promise(resolve => setImmediate(resolve));
    if (invalidate === 'turn') { fixture.state.status = 'running'; fixture.host.invalidate(fixture.agent); }
    if (invalidate === 'config') fixture.host.invalidate();
    if (invalidate === 'dispose') fixture.host.dispose();
    if (invalidate === 'caller') abort.abort();
    resolve();
    const result = await pending;
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.suggestion, null);
    assert.equal(fixture.calls[0].signal?.aborted, true);
  }
});

test('server rechecks round/liveness even if no lifecycle notification arrived', async () => {
  let resolve!: () => void;
  const wait = new Promise<void>(done => { resolve = done; });
  const fixture = setup(async function* () { await wait; yield { type: 'text-delta', index: 0, text: 'obsolete' }; yield { type: 'finish', reason: { kind: 'stop' } }; });
  const pending = fixture.host.suggest(request, signal());
  fixture.state.events[0].seq = 21;
  resolve();
  const result = await pending;
  assert.equal(result.ok && result.value.suggestion, null);
});

test('provider diagnostics are contained in a generic retryable result', async () => {
  const fixture = setup(async function* () { throw new Error('private key and provider diagnostic'); });
  const result = await fixture.host.suggest(request, signal());
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('host attempt timeout settles even when the provider ignores the signal', async () => {
  const fixture = setup();
  fixture.policy.timeoutMs = 5;
  fixture.ports.llm.stream = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) });
  const result = await fixture.host.suggest(request, signal());
  assert.equal(result.ok, false);
});

test('multiple clients retain independent request identities without a server-wide latest counter', async () => {
  const fixture = setup();
  const [first, second] = await Promise.all([fixture.host.suggest({ ...request, requestId: 99 }, signal()), fixture.host.suggest(request, signal())]);
  assert.equal(first.ok && first.value.suggestion, '请运行测试。');
  assert.equal(second.ok && second.value.suggestion, '请运行测试。');
  assert.equal(first.ok && first.value.requestId, 99);
  assert.equal(second.ok && second.value.requestId, 1);
});

function longHistory(count = 24) {
  return Array.from({ length: count }, (_, index) => index % 2 === 0
    ? createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: `用户约束 ${index}：保留 API，并使用中文。` }] })
    : createAssistantMessage({ source: { provider: 'session-provider', model: 'session-model' }, content: [{ type: 'text', text: `助手回复 ${index}：接下来检查测试。` }] }));
}

test('long history is summarized before suggesting and unchanged context reuses its successful summary', async () => {
  const fixture = setup(async function* (options) {
    yield { type: 'text-delta', index: 0, text: options.purpose === 'compaction' ? '用户要求保留 API，使用中文；尚待测试。' : '请继续验证测试。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const messages = longHistory();
  fixture.agent.session.deriveMessages = () => messages;
  const first = await fixture.host.suggest(request, signal());
  assert.equal(first.ok && first.value.suggestion, '请继续验证测试。');
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0].purpose, 'compaction');
  const framed = fixture.calls[1].messages[0].content[0] as { text: string };
  const suggestionContext = JSON.parse(framed.text);
  assert.equal(suggestionContext.summary, '用户要求保留 API，使用中文；尚待测试。');
  assert.equal(suggestionContext.recent.length, 8);
  assert.equal(suggestionContext.recent.at(-1).text, '助手回复 23：接下来检查测试。');
  const second = await fixture.host.suggest({ ...request, requestId: 2 }, signal());
  assert.equal(second.ok && second.value.suggestion, '请继续验证测试。');
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls.filter(call => call.purpose === 'compaction').length, 1);
  fixture.host.invalidate();
  await fixture.host.suggest({ ...request, requestId: 3 }, signal());
  assert.equal(fixture.calls.filter(call => call.purpose === 'compaction').length, 2);
});

test('a suggestion retry reuses a successful compression and never appends auxiliary messages', async () => {
  let failSuggestion = true;
  const fixture = setup(async function* (options) {
    if (options.purpose !== 'compaction' && failSuggestion) { failSuggestion = false; throw new Error('suggestion failed'); }
    yield { type: 'text-delta', index: 0, text: options.purpose === 'compaction' ? '保留旧上下文中的用户约束。' : '请运行测试。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  const messages = longHistory();
  fixture.agent.session.deriveMessages = () => messages;
  const before = JSON.stringify(messages);
  assert.equal((await fixture.host.suggest(request, signal())).ok, false);
  const retried = await fixture.host.suggest(request, signal());
  assert.equal(retried.ok && retried.value.suggestion, '请运行测试。');
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls.filter(call => call.purpose === 'compaction').length, 1);
  assert.equal(JSON.stringify(messages), before);
  assert.equal(fixture.state.events.length, 1);
});

test('failed compression produces no suggestion call and is retried silently as a fresh attempt', async () => {
  let failCompression = true;
  const fixture = setup(async function* (options) {
    if (options.purpose === 'compaction' && failCompression) { failCompression = false; throw new Error('private summary failure'); }
    yield { type: 'text-delta', index: 0, text: options.purpose === 'compaction' ? '已压缩上下文。' : '请继续。' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  });
  fixture.agent.session.deriveMessages = () => longHistory();
  const failed = await fixture.host.suggest(request, signal());
  assert.equal(failed.ok, false);
  assert.equal(fixture.calls.length, 1);
  assert.equal(JSON.stringify(failed).includes('private'), false);
  const retried = await fixture.host.suggest(request, signal());
  assert.equal(retried.ok && retried.value.suggestion, '请继续。');
  assert.equal(fixture.calls.length, 3);
});

test('exact Connection route preserves RPC envelopes without occupying the Gateway interceptor', async () => {
  const fixture = setup();
  let route!: ConnectionFetchRoute;
  const listeners = new Map<string, Function>();
  const fake = { ...fixture.ports, effect: () => {}, on: (event: string, listener: Function) => listeners.set(event, listener),
    connection: { fetch: { register: (registered: ConnectionFetchRoute) => { route = registered; } } } };
  apply(fake as unknown as Context, Config({}));
  assert.equal(route.path, '/api/next-input/suggest');
  assert.equal(route.requestBody, 'buffered');
  assert.equal(listeners.has('loader/volatile-update'), true);
  const response = await route.fetch(new Request('http://localhost/api/next-input/suggest', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'request-1', method: RPC_ENDPOINT, payload: request }),
  }));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.type, 'server-response');
  assert.equal(body.rpcId, 'request-1');
  assert.equal(body.result.value.suggestion, '请运行测试。');
});

test('native Cordis registration removes the route and aborts hanging generation during unload', async () => {
  const fixture = setup();
  const ctx = new Context();
  const providers = ctx.plugin({ name: 'test-host-providers', apply(providerCtx: Context) {
    providerCtx.provide('agents', fixture.ports.agents as AgentRegistry);
    providerCtx.provide('llm', fixture.ports.llm as LlmRuntime);
    new HostConnectionService(providerCtx, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
  } });
  try {
    await providers.await();
    const fiber = ctx.plugin({ name, inject, Config, apply }, {});
    await fiber.await();
    const connection = ctx.get('connection');
    assert.ok(connection);
    const shared = connection.createSharedFetchHandler('/api');
    const fetchRequest = () => new Request('http://localhost/api/next-input/suggest', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'native-request', method: RPC_ENDPOINT, payload: request }),
    });
    assert.equal((await shared.fetch(fetchRequest())).status, 200);
    fixture.ports.llm.stream = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) });
    const pending = shared.fetch(fetchRequest());
    await new Promise(resolve => setImmediate(resolve));
    await fiber.dispose();
    const retired = await (await pending).json();
    assert.equal(retired.result.value.suggestion, null);
    assert.equal((await shared.fetch(fetchRequest())).status, 404);
    const replacement = ctx.plugin({ name, inject, Config, apply }, {});
    await replacement.await();
    await replacement.dispose();
    assert.equal((await shared.fetch(fetchRequest())).status, 404);
  } finally {
    await ctx.fiber.dispose();
  }
});
