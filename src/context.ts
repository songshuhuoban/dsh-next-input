import { createHash } from 'node:crypto';
import type { Message } from '@deepseek-ai/dsh-llm';
import type { CompactionCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import { summarizeConversation, type LlmStreamPort, type TranscriptLine } from './generation.js';

const CONTEXT_CHARS = 12_000;
const SUMMARY_CHARS = 2_000;
const RECENT_CHARS = CONTEXT_CHARS - SUMMARY_CHARS;
const RECENT_MESSAGES = 8;
const SHORT_MESSAGES = 16;
const SUMMARY_INPUT_CHARS = 24_000;

interface VisibleLine extends TranscriptLine { id: string; chars: number; order: number }
interface SummaryUnit extends TranscriptLine { fingerprint: string; chars: number }
interface Cache {
  route: string;
  checkpoint: string;
  covered: readonly string[];
  summary: string | null;
}

export interface PrepareContextInput {
  llm: LlmStreamPort;
  route: { provider: string; model: string };
  /** Only Session.deriveMessages(), never the superseded append-only log. */
  messages: readonly Message[];
  signal: AbortSignal;
}
export interface PreparedContext { summary: string | null; recent: TranscriptLine[] }

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function chars(text: string): number {
  let count = 0;
  for (const _character of text) count++;
  return count;
}
function visibleText(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

/** Break at Unicode code points, never halfway through a surrogate pair. */
function units(line: VisibleLine): SummaryUnit[] {
  const result: SummaryUnit[] = [];
  let text = '';
  let length = 0;
  let offset = 0;
  const append = () => {
    result.push({ role: line.role, text, chars: length,
      fingerprint: fingerprint([line.id, line.role, offset, text]) });
    offset += length;
    text = '';
    length = 0;
  };
  for (const character of line.text) {
    text += character;
    if (++length === SUMMARY_INPUT_CHARS) append();
  }
  if (length !== 0) append();
  return result;
}

/** Keep the recent tail verbatim and return every overflow character for summary. */
function splitHistory(lines: readonly VisibleLine[]): { older: VisibleLine[]; recent: TranscriptLine[] } {
  const recent: TranscriptLine[] = [];
  let remaining = RECENT_CHARS;
  let boundary = lines.length;
  let partial: VisibleLine | undefined;
  for (let index = lines.length - 1; index >= 0 && recent.length < RECENT_MESSAGES && remaining > 0; index--) {
    const line = lines[index];
    boundary = index;
    if (line.chars <= remaining) {
      recent.push({ role: line.role, text: line.text });
      remaining -= line.chars;
    } else {
      const points = [...line.text];
      const cut = points.length - remaining;
      recent.push({ role: line.role, text: points.slice(cut).join('') });
      partial = { ...line, text: points.slice(0, cut).join(''), chars: cut };
      remaining = 0;
    }
  }
  const older = lines.slice(0, boundary);
  if (partial) older.push(partial);
  return { older, recent: recent.reverse() };
}

/**
 * Own one preparer per live Agent. Forks/replacements get another preparer;
 * compaction and edits are recognized from the current derived surface itself.
 */
export function createContextPreparer(): {
  prepare(input: PrepareContextInput): Promise<PreparedContext>;
  clear(): void;
} {
  let cache: Cache | undefined;
  let generation = 0;

  return {
    clear() { cache = undefined; generation++; },
    async prepare(input) {
      input.signal.throwIfAborted();
      const currentGeneration = ++generation;
      const lines: VisibleLine[] = [];
      const checkpoints: Array<VisibleLine & { compactionId: string }> = [];
      for (const [order, message] of input.messages.entries()) {
        input.signal.throwIfAborted();
        const text = visibleText(message);
        if (!text.trim()) continue;
        // This marker is owned by the backend-independent checkpoint contract.
        const source = message.source as { kind: string };
        if (message.role === 'user' && source.kind === 'compact-checkpoint') {
          const checkpoint = message.source as unknown as CompactionCheckpointSource;
          checkpoints.push({ id: message.id, role: 'user', text, chars: chars(text), order,
            compactionId: String(checkpoint.compactionId ?? '') });
        } else if (message.role === 'assistant' || message.role === 'user' && source.kind === 'user') {
          lines.push({ id: message.id, role: message.role, text, chars: chars(text), order });
        }
      }
      const baseline = checkpoints.map(line => line.text).join('\n\n') || null;
      const baselineChars = baseline === null ? 0 : chars(baseline);
      const totalChars = baselineChars + lines.reduce((sum, line) => sum + line.chars, 0);
      const lastCheckpoint = checkpoints.at(-1)?.order ?? -1;
      const checkpointsFirst = !lines.length || lastCheckpoint < lines[0].order;
      if (checkpointsFirst && lines.length <= SHORT_MESSAGES && totalChars <= CONTEXT_CHARS && baselineChars <= SUMMARY_CHARS) {
        // A short current surface is already complete; do not pull a previous
        // longer surface back into it through a cached summary.
        if (generation === currentGeneration) cache = undefined;
        return { summary: baseline, recent: lines.map(({ role, text }) => ({ role, text })) };
      }

      const beforeCheckpoint = lines.filter(line => line.order < lastCheckpoint);
      const tail = lines.filter(line => line.order > lastCheckpoint);
      const { older: olderTail, recent } = splitHistory(tail);
      const older = [...beforeCheckpoint, ...olderTail];
      const route = fingerprint([input.route.provider, input.route.model]);
      const checkpoint = fingerprint(checkpoints.map(line => [line.id, line.compactionId, line.text]));
      // Existing Harness checkpoints are reused verbatim when they fit the
      // summary budget. Oversized checkpoints are reduced through the same
      // bounded hierarchy as oversized individual conversation messages.
      const useBaseline = checkpointsFirst && baselineChars <= SUMMARY_CHARS;
      const prefix = [...(useBaseline ? [] : checkpoints), ...older]
        .sort((left, right) => left.order - right.order).flatMap(units);
      const keys = prefix.map(unit => unit.fingerprint);
      const reusable = cache?.route === route && cache.checkpoint === checkpoint
        && cache.covered.length <= keys.length
        && cache.covered.every((key, index) => key === keys[index]);
      let covered = reusable && cache ? cache.covered.length : 0;
      let summary = reusable && cache ? cache.summary : useBaseline ? baseline : null;

      while (covered < prefix.length) {
        input.signal.throwIfAborted();
        let end = covered;
        let size = 0;
        while (end < prefix.length && size + prefix[end].chars <= SUMMARY_INPUT_CHARS) {
          size += prefix[end].chars;
          end++;
        }
        const updated = await summarizeConversation({
          llm: input.llm, route: input.route, previousSummary: summary,
          transcript: prefix.slice(covered, end).map(({ role, text }) => ({ role, text })),
          maxSummaryChars: SUMMARY_CHARS, signal: input.signal,
        });
        input.signal.throwIfAborted();
        summary = updated;
        covered = end;
        // A successful prefix is safe to reuse if a later chunk fails or times
        // out. Partial progress is private, never a placeholder or a draft.
        if (generation === currentGeneration) cache = { route, checkpoint, covered: keys.slice(0, covered), summary };
      }
      input.signal.throwIfAborted();
      return { summary, recent };
    },
  };
}
