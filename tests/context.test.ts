import assert from 'node:assert/strict';
import test from 'node:test';
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm';
import { createContextPreparer, type PrepareContextInput } from '../src/context.js';
import type { LlmStreamPort, TranscriptLine } from '../src/generation.js';

interface SummaryPayload { previousSummary: string | null; conversation: TranscriptLine[] }
function message(id: string, text: string, role: Message['role'] = 'user', kind = role === 'assistant' ? 'model' : 'user', blocks: ContentBlock[] = []): Message {
  return { id, role, source: { kind, provider: 'provider', model: 'model', compactionId: `compact-${id}` },
    content: [{ type: 'text', text }, ...blocks] } as unknown as Message;
}
function history(count: number): Message[] {
  return Array.from({ length: count }, (_, index) => message(`message-${index}`, `Message ${index}: keep constraint ${index}.`, index % 2 ? 'assistant' : 'user'));
}
function fixture(respond: (payload: SummaryPayload, index: number) => string | Promise<string> = (_payload, index) => `Summary ${index}`) {
  const calls: Array<{ payload: SummaryPayload; options: GenerateOptions }> = [];
  const llm: LlmStreamPort = { async *stream(options) {
    const block = options.messages[0].content[0];
    assert.equal(block.type, 'text');
    if (block.type !== 'text') throw new Error('Expected summary input');
    const payload = JSON.parse(block.text) as SummaryPayload;
    calls.push({ payload, options });
    const text = await respond(payload, calls.length);
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } };
  const preparer = createContextPreparer();
  const input = (messages: readonly Message[], signal = new AbortController().signal): PrepareContextInput =>
    ({ llm, route: { provider: 'provider', model: 'model' }, messages, signal });
  return { calls, llm, preparer, input };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
const size = (text: string) => [...text].length;

test('short histories retain every visible message verbatim without an extra LLM call', async () => {
  const f = fixture();
  const messages = history(16);
  messages[0] = message('message-0', '  Original constraint\nwith whitespace.  ');
  const result = await f.preparer.prepare(f.input(messages));
  assert.equal(f.calls.length, 0);
  assert.equal(result.summary, null);
  assert.equal(result.recent.length, 16);
  assert.equal(result.recent[0].text, '  Original constraint\nwith whitespace.  ');
  assert.equal(result.recent.at(-1)?.text, 'Message 15: keep constraint 15.');
});

test('uses the current Harness checkpoint as baseline and excludes tools, system, injected context, and reasoning', async () => {
  const f = fixture();
  const messages = [
    message('system', 'Secret system instructions', 'system', 'system-prompt'),
    message('checkpoint', 'Earlier user constraints and decisions.', 'user', 'compact-checkpoint'),
    message('injected', 'Private injected context'.repeat(5_000), 'user', 'agent-context'),
    message('tool', 'Private tool result', 'tool', 'tool'),
    message('user', '  Please continue.  '),
    message('assistant', 'Which test should run?', 'assistant', 'model', [{ type: 'reasoning', text: 'Hidden chain of thought' }]),
  ];
  const result = await f.preparer.prepare(f.input(messages));
  assert.equal(f.calls.length, 0);
  assert.equal(result.summary, 'Earlier user constraints and decisions.');
  assert.deepEqual(result.recent, [
    { role: 'user', text: '  Please continue.  ' }, { role: 'assistant', text: 'Which test should run?' },
  ]);
  assert.equal(JSON.stringify(result).includes('Private'), false);
  assert.equal(JSON.stringify(result).includes('Hidden'), false);
});

test('summarizes the older prefix and incrementally merges only newly displaced messages', async () => {
  const f = fixture();
  const first = await f.preparer.prepare(f.input(history(20)));
  assert.equal(first.summary, 'Summary 1');
  assert.deepEqual(first.recent.map(line => line.text), history(20).slice(-8).map(item => item.content[0].type === 'text' && item.content[0].text));
  assert.equal(f.calls[0].payload.previousSummary, null);
  assert.equal(f.calls[0].payload.conversation.length, 12);
  assert.match(f.calls[0].payload.conversation[0].text, /constraint 0/);
  const second = await f.preparer.prepare(f.input(history(22)));
  assert.equal(second.summary, 'Summary 2');
  assert.equal(f.calls[1].payload.previousSummary, 'Summary 1');
  assert.deepEqual(f.calls[1].payload.conversation.map(line => line.text), [
    'Message 12: keep constraint 12.', 'Message 13: keep constraint 13.',
  ]);
  const cached = await f.preparer.prepare(f.input(history(22)));
  assert.deepEqual(cached, second);
  assert.equal(f.calls.length, 2);
});

test('edited prefixes, replaced message identities, provider/model changes, and clear invalidate cached summaries', async () => {
  const f = fixture();
  await f.preparer.prepare(f.input(history(20)));
  const edited = history(20);
  edited[0] = message('message-0', 'The constraint was explicitly changed.');
  await f.preparer.prepare(f.input(edited));
  assert.equal(f.calls[1].payload.previousSummary, null);
  assert.equal(f.calls[1].payload.conversation[0].text, 'The constraint was explicitly changed.');
  edited[0] = message('new-identity', 'The constraint was explicitly changed.');
  await f.preparer.prepare(f.input(edited));
  assert.equal(f.calls[2].payload.previousSummary, null);
  const changedRoute = { ...f.input(edited), route: { provider: 'different-provider', model: 'different-model' } };
  await f.preparer.prepare(changedRoute);
  assert.equal(f.calls[3].payload.previousSummary, null);
  assert.equal(f.calls[3].options.model, 'different-model');
  f.preparer.clear();
  await f.preparer.prepare(changedRoute);
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[4].payload.previousSummary, null);
});

test('a new checkpoint replaces cached history rather than resurrecting shadowed constraints', async () => {
  const f = fixture();
  await f.preparer.prepare(f.input(history(20)));
  const currentSurface = [message('new-checkpoint', 'Superseding compacted context.', 'user', 'compact-checkpoint'), ...history(18).map((item, index) => message(`new-${index}`, `Current ${index}`))];
  const result = await f.preparer.prepare(f.input(currentSurface));
  assert.equal(f.calls[1].payload.previousSummary, 'Superseding compacted context.');
  assert.equal(f.calls[1].payload.conversation.some(line => line.text.includes('constraint')), false);
  assert.equal(result.recent.every(line => line.text.startsWith('Current')), true);
});

test('checkpoints in the middle of the current surface preserve chronology during reduction', async () => {
  const f = fixture();
  const result = await f.preparer.prepare(f.input([
    message('before', 'Older still-visible constraint.'),
    message('checkpoint', 'A later checkpoint revises that constraint.', 'user', 'compact-checkpoint'),
    message('after', 'Current question.'),
  ]));
  assert.deepEqual(f.calls[0].payload.conversation.map(line => line.text), [
    'Older still-visible constraint.', 'A later checkpoint revises that constraint.',
  ]);
  assert.deepEqual(result.recent, [{ role: 'user', text: 'Current question.' }]);
});

test('failed summary output is never reused as a successful cache entry', async () => {
  const f = fixture((_payload, index) => {
    if (index === 1) throw new Error('Provider failed');
    return 'Recovered summary';
  });
  await assert.rejects(f.preparer.prepare(f.input(history(20))));
  const result = await f.preparer.prepare(f.input(history(20)));
  assert.equal(result.summary, 'Recovered summary');
  assert.equal(f.calls[1].payload.previousSummary, null);
  assert.equal(f.calls[1].payload.conversation.length, 12);
});

test('out-of-order completions cannot replace the newest successful summary cache', async () => {
  const old = deferred<string>();
  const f = fixture((_payload, index) => index === 1 ? old.promise : 'Newest summary');
  const oldPreparation = f.preparer.prepare(f.input(history(20)));
  await flush();
  const edited = history(20);
  edited[0] = message('edited', 'New constraints.');
  const latest = await f.preparer.prepare(f.input(edited));
  old.resolve('Obsolete summary');
  await oldPreparation;
  const cached = await f.preparer.prepare(f.input(edited));
  assert.deepEqual(cached, latest);
  assert.equal(cached.summary, 'Newest summary');
  assert.equal(f.calls.length, 2);
});

test('cancelled preparations consume late results and do not cache them', async () => {
  const late = deferred<string>();
  const f = fixture((_payload, index) => index === 1 ? late.promise : 'Fresh summary');
  const controller = new AbortController();
  const pending = f.preparer.prepare(f.input(history(20), controller.signal));
  const rejected = assert.rejects(pending);
  await flush();
  controller.abort();
  await rejected;
  late.resolve('Cancelled summary');
  await flush();
  const result = await f.preparer.prepare(f.input(history(20)));
  assert.equal(result.summary, 'Fresh summary');
  assert.equal(f.calls[1].payload.previousSummary, null);
});

test('successful hierarchical chunks survive a later failure so retries resume the validated prefix', async () => {
  const f = fixture((_payload, index) => {
    if (index === 2) throw new Error('Second chunk failed');
    return `Chunk summary ${index}`;
  });
  const messages = [message('large', 'A'.repeat(70_000)), ...history(8)];
  await assert.rejects(f.preparer.prepare(f.input(messages)));
  const result = await f.preparer.prepare(f.input(messages));
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[2].payload.previousSummary, 'Chunk summary 1');
  assert.equal(f.calls[2].payload.conversation[0].text.length, 24_000);
  assert.equal(f.calls[3].payload.previousSummary, 'Chunk summary 3');
  assert.equal(result.summary, 'Chunk summary 4');
  assert.equal(result.recent.length, 8);
});

test('giant Unicode messages are split without losing characters and keep output within the context budget', async () => {
  const f = fixture();
  const text = '😀'.repeat(65_000);
  const result = await f.preparer.prepare(f.input([message('giant', text)]));
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every(call => call.payload.conversation.reduce((sum, line) => sum + size(line.text), 0) <= 24_000));
  const summarizedInput = f.calls.flatMap(call => call.payload.conversation).map(line => line.text).join('');
  assert.equal(summarizedInput + result.recent[0].text, text);
  assert.equal(size(result.recent[0].text), 10_000);
  assert.ok(size(result.summary ?? '') + result.recent.reduce((sum, line) => sum + size(line.text), 0) <= 12_000);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(JSON.stringify(result)));
});

test('oversized checkpoints are reduced instead of silently truncating their constraints', async () => {
  const f = fixture();
  const checkpoint = 'Earlier constraints.'.repeat(2_000);
  const result = await f.preparer.prepare(f.input([
    message('large-checkpoint', checkpoint, 'user', 'compact-checkpoint'), message('current', 'What next?'),
  ]));
  assert.equal(f.calls.flatMap(call => call.payload.conversation).map(line => line.text).join(''), checkpoint);
  assert.ok(size(result.summary ?? '') <= 2_000);
  assert.deepEqual(result.recent, [{ role: 'user', text: 'What next?' }]);
});

test('overlong summarizer responses fail and remain uncached', async () => {
  const f = fixture((_payload, index) => index === 1 ? 'X'.repeat(2_001) : 'Valid summary');
  await assert.rejects(f.preparer.prepare(f.input(history(20))));
  const result = await f.preparer.prepare(f.input(history(20)));
  assert.equal(result.summary, 'Valid summary');
  assert.equal(f.calls[1].payload.previousSummary, null);
});
