import assert from 'node:assert/strict';
import test from 'node:test';
import { ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { generateSuggestion, summarizeConversation, type LlmStreamPort } from '../src/generation.js';

function fixture(chunks: StreamChunk[]): { llm: LlmStreamPort; calls: GenerateOptions[] } {
  const calls: GenerateOptions[] = [];
  return { calls, llm: { async *stream(options) { calls.push(options); yield* chunks; } } };
}
function args(llm: LlmStreamPort) {
  return { llm, route: { provider: 'inherited-provider', model: 'inherited-model' },
    transcript: [{ role: 'user' as const, text: '请继续' }, { role: 'assistant' as const, text: '需要我检查测试吗？' }],
    maxSuggestionChars: 240, signal: new AbortController().signal };
}
function modelInfo(efforts: string[]): LlmResolvedModelInfo {
  return { provider: 'inherited-provider', id: 'inherited-model', name: 'Inherited model',
    reasoning: { efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })) } };
}

test('auxiliary calls use only explicitly advertised off/none efforts and keep their actual purpose', async () => {
  for (const supported of [['high', 'off'], ['none', 'off'], ['high', 'none']]) {
    const { llm, calls } = fixture([{ type: 'text-delta', index: 0, text: '请继续。' }, { type: 'finish', reason: { kind: 'stop' } }]);
    const lookups: unknown[][] = [];
    llm.resolveModelInfo = async function (provider, model, signal) {
      assert.equal(this, llm);
      lookups.push([provider, model, signal]);
      return modelInfo(supported);
    };
    const request = args(llm);
    await generateSuggestion(request);
    await summarizeConversation({ ...request, previousSummary: null, maxSummaryChars: 2_000 });
    const selected = supported.includes('off') ? 'off' : 'none';
    assert.equal(calls[0].reasoningEffort, selected);
    assert.equal(calls[1].reasoningEffort, selected);
    assert.equal(calls[0].purpose, undefined);
    assert.equal(calls[1].purpose, 'compaction');
    assert.equal(calls[0].maxTokens, 480);
    assert.equal(calls[1].maxTokens, 2_048);
    assert.deepEqual(lookups, [
      ['inherited-provider', 'inherited-model', request.signal],
      ['inherited-provider', 'inherited-model', request.signal],
    ]);
  }
});

test('reasoning-only and unknown models retain their default effort and output budget', async () => {
  for (const info of [undefined, { ...modelInfo(['vendor-disabled']), reasoning: {
    efforts: [{ id: ReasoningEffortId('vendor-disabled'), name: 'Off' }], defaultEffort: ReasoningEffortId('vendor-disabled'),
  } }, modelInfo(['low', 'high']), { provider: 'inherited-provider', id: 'inherited-model', name: 'Unknown reasoning' }]) {
    const { llm, calls } = fixture([{ type: 'text-delta', index: 0, text: '请继续。' }, { type: 'finish', reason: { kind: 'stop' } }]);
    if (info) llm.resolveModelInfo = async () => info;
    await generateSuggestion(args(llm));
    await summarizeConversation({ ...args(llm), previousSummary: null, maxSummaryChars: 2_000 });
    assert.equal(calls[0].reasoningEffort, undefined, 'opaque ids and display names must not be guessed');
    assert.equal(calls[1].reasoningEffort, undefined);
    assert.equal(calls[0].maxTokens, undefined);
    assert.equal(calls[1].maxTokens, undefined);
  }
});

test('metadata failures and canceled metadata lookup never dispatch an auxiliary stream', async () => {
  const failed = fixture([{ type: 'finish', reason: { kind: 'stop' } }]);
  failed.llm.resolveModelInfo = async () => { throw new Error('metadata lookup failed'); };
  await assert.rejects(generateSuggestion(args(failed.llm)), /metadata lookup failed/u);
  assert.equal(failed.calls.length, 0);

  for (const summarize of [false, true]) {
    const { llm, calls } = fixture([{ type: 'finish', reason: { kind: 'stop' } }]);
    let rejectLate!: (error: Error) => void;
    const abort = new AbortController();
    llm.resolveModelInfo = (_provider, _model, signal) => {
      assert.equal(signal, abort.signal);
      return new Promise((_resolve, reject) => { rejectLate = reject; });
    };
    const request = { ...args(llm), signal: abort.signal };
    const pending = summarize
      ? summarizeConversation({ ...request, previousSummary: null, maxSummaryChars: 2_000 })
      : generateSuggestion(request);
    await new Promise(resolve => setImmediate(resolve));
    abort.abort(new Error('lookup timed out'));
    await assert.rejects(pending, /lookup timed out/u);
    assert.equal(calls.length, 0);
    rejectLate(new Error('late lookup failure'));
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('integrated stream inherits provider/model and sends one tool-free JSON-framed auxiliary request', async () => {
  const { llm, calls } = fixture([{ type: 'text-delta', index: 0, text: '  请检查\n' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '  请检查\n测试。  ' } }, { type: 'finish', reason: { kind: 'stop' } }]);
  assert.equal(await generateSuggestion(args(llm)), '请检查 测试。');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider, 'inherited-provider');
  assert.equal(calls[0].model, 'inherited-model');
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[0].messages.length, 1);
  const inputText = calls[0].messages[0].content[0];
  assert.equal(inputText.type, 'text');
  assert.deepEqual(JSON.parse((inputText as { text: string }).text), { summary: null, recent: args(llm).transcript });
});

test('interleaved reasoning is ignored and final text blocks replace accumulated deltas', async () => {
  const { llm } = fixture([{ type: 'reasoning-delta', index: 0, text: 'hidden' },
    { type: 'text-delta', index: 2, text: 'later' }, { type: 'text-delta', index: 1, text: 'first' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'final first ' } }, { type: 'finish', reason: { kind: 'stop' } }]);
  assert.equal(await generateSuggestion(args(llm)), 'final first later');
});

test('errors, unfinished/overlong/empty/control outputs never become suggestions', async () => {
  const cases: StreamChunk[][] = [
    [{ type: 'text-delta', index: 0, text: 'partial' }, { type: 'finish', reason: { kind: 'error', failure: { code: 'FAIL', message: 'secret provider diagnostic' } } }],
    [{ type: 'text-delta', index: 0, text: 'partial' }],
    [{ type: 'text-delta', index: 0, text: 'x'.repeat(241) }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'text-delta', index: 0, text: 'bad\u001btext' }, { type: 'finish', reason: { kind: 'stop' } }],
    [{ type: 'finish', reason: { kind: 'max-tokens' } }],
    [{ type: 'finish', reason: { kind: 'stop' } }, { type: 'text-delta', index: 0, text: 'invalid' }],
  ];
  for (const chunks of cases) await assert.rejects(generateSuggestion(args(fixture(chunks).llm)));
});

test('cancellation aborts before any model call and before accepting a terminal stream', async () => {
  const abort = new AbortController();
  abort.abort();
  const { llm, calls } = fixture([{ type: 'finish', reason: { kind: 'stop' } }]);
  await assert.rejects(generateSuggestion({ ...args(llm), signal: abort.signal }));
  assert.equal(calls.length, 0);
});

test('a hanging adapter cannot hold cancellation open, even if iterator.return also hangs', async () => {
  let returns = 0;
  let rejectLate!: (error: Error) => void;
  const never = new Promise<IteratorResult<StreamChunk>>((_resolve, reject) => { rejectLate = reject; });
  const llm: LlmStreamPort = { stream: () => ({ [Symbol.asyncIterator]: () => ({
    next: () => never,
    return: () => { returns++; return new Promise<IteratorResult<StreamChunk>>(() => {}); },
  }) }) };
  const abort = new AbortController();
  const pending = generateSuggestion({ ...args(llm), signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  abort.abort(new Error('canceled'));
  await assert.rejects(pending, /canceled/u);
  assert.equal(returns, 1);
  rejectLate(new Error('late provider failure'));
  await new Promise(resolve => setImmediate(resolve));
});

test('summary and recent context are JSON-framed together in the suggestion request', async () => {
  const { llm, calls } = fixture([{ type: 'text-delta', index: 0, text: '请继续检查' }, { type: 'finish', reason: { kind: 'stop' } }]);
  await generateSuggestion({ ...args(llm), summary: '用户要求使用中文并保留原始 API。' });
  const content = calls[0].messages[0].content[0] as { type: 'text'; text: string };
  assert.deepEqual(JSON.parse(content.text), { summary: '用户要求使用中文并保留原始 API。', recent: args(llm).transcript });
});

test('a native compaction checkpoint may provide the entire remaining conversation context', async () => {
  const { llm, calls } = fixture([{ type: 'text-delta', index: 0, text: '请继续处理待办。' }, { type: 'finish', reason: { kind: 'stop' } }]);
  assert.equal(await generateSuggestion({ ...args(llm), transcript: [], summary: '用户要求保留 API；待办是验证接口。' }), '请继续处理待办。');
  assert.equal(calls.length, 1);
  await assert.rejects(generateSuggestion({ ...args(llm), transcript: [], summary: '' }));
});

test('compression uses the same provider route and preserves a factual summary without Session mutation', async () => {
  const { llm, calls } = fixture([{ type: 'text-delta', index: 0, text: '用户约束：使用中文。\n待办：验证接口。' }, { type: 'finish', reason: { kind: 'stop' } }]);
  const result = await summarizeConversation({ ...args(llm), previousSummary: '早期决定：继承系统凭据。', maxSummaryChars: 2_000 });
  assert.equal(result, '用户约束：使用中文。\n待办：验证接口。');
  assert.equal(calls[0].purpose, 'compaction');
  assert.equal(calls[0].provider, 'inherited-provider');
  assert.equal(calls[0].model, 'inherited-model');
  assert.equal(calls[0].tools, undefined);
  assert.equal(calls[0].sessionId, undefined);
  assert.equal(calls[0].maxTokens, undefined);
  const framed = calls[0].messages[0].content[0] as { type: 'text'; text: string };
  assert.deepEqual(JSON.parse(framed.text), { previousSummary: '早期决定：继承系统凭据。', conversation: args(llm).transcript });
  assert.match(calls[0].system!, /goals.*constraints.*preferences.*decisions/u);
  assert.match(calls[0].system!, /Do not invent facts/u);
});

test('compression failures and ignored cancellation share suggestion error handling', async () => {
  const failed = fixture([{ type: 'finish', reason: { kind: 'error', failure: { code: 'FAIL', message: 'hidden' } } }]);
  await assert.rejects(summarizeConversation({ ...args(failed.llm), previousSummary: null, maxSummaryChars: 2_000 }));
  const llm: LlmStreamPort = { stream: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) }) };
  const abort = new AbortController();
  const pending = summarizeConversation({ ...args(llm), previousSummary: null, maxSummaryChars: 2_000, signal: abort.signal });
  abort.abort(new Error('compressed request canceled'));
  await assert.rejects(pending, /compressed request canceled/u);
});
