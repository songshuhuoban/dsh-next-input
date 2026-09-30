import assert from 'node:assert/strict';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import LlmRuntime, { LlmAdapter, ReasoningEffortId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { generateSuggestion } from '../src/generation.js';

test('suggestions route through the native dsh LLM runtime and respect adapter removal', async () => {
  const ctx = new Context();
  const calls: GenerateOptions[] = [];
  const metadataRoutes: string[][] = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      metadataRoutes.push([provider, model]);
      return { provider, id: model, name: model, reasoning: {
        efforts: ['high', 'off'].map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId('high'),
      } };
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options);
      // Reproduce a provider whose short default budget is exhausted by reasoning.
      if (options.reasoningEffort !== 'off') {
        yield { type: 'finish', reason: { kind: 'max-tokens' } };
        return;
      }
      yield { type: 'text-delta', index: 0, text: '请继续。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  try {
    await ctx.plugin(LlmRuntime).await();
    const registration = ctx.llm.registerAdapter(['suggestion-test'], new Adapter());
    const request = {
      llm: ctx.llm,
      route: { provider: 'suggestion-test', model: 'session-model' },
      transcript: [{ role: 'assistant' as const, text: '还要继续吗？' }],
      maxSuggestionChars: 240,
      signal: new AbortController().signal,
    };
    assert.equal(await generateSuggestion(request), '请继续。');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].provider, 'suggestion-test');
    assert.equal(calls[0].model, 'session-model');
    assert.equal(calls[0].tools, undefined);
    assert.equal(calls[0].reasoningEffort, 'off');
    assert.equal(calls[0].maxTokens, 480);
    assert.ok(metadataRoutes.length >= 1);
    assert.ok(metadataRoutes.every(([provider, model]) => provider === 'suggestion-test' && model === 'session-model'));
    registration();
    await assert.rejects(generateSuggestion(request));
    assert.equal(calls.length, 1, 'removed adapters cannot be reused by a cached plugin route');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('native dsh runtime materializes reasoning-only adapter defaults without a guessed effort or budget', async () => {
  const ctx = new Context();
  const calls: GenerateOptions[] = [];
  class Adapter extends LlmAdapter {
    async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
      return { provider, id: model, name: model, defaultMaxTokens: 4_096,
        reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') } };
    }
    async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(options);
      yield { type: 'text-delta', index: 0, text: '请继续。' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  try {
    await ctx.plugin(LlmRuntime).await();
    ctx.llm.registerAdapter(['reasoning-only'], new Adapter());
    assert.equal(await generateSuggestion({ llm: ctx.llm,
      route: { provider: 'reasoning-only', model: 'session-model' },
      transcript: [{ role: 'assistant', text: '还要继续吗？' }],
      maxSuggestionChars: 240, signal: new AbortController().signal }), '请继续。');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].reasoningEffort, 'high');
    assert.equal(calls[0].maxTokens, 4_096);
    assert.equal(calls[0].sessionId, undefined);
  } finally {
    await ctx.fiber.dispose();
  }
});
