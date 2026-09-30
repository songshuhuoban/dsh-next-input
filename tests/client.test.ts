import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Window } from 'happy-dom';
import { DEFAULT_CONFIG } from '../src/protocol.js';

type AnyRecord = Record<string, any>;
function observable<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    set(next: T) { value = next; for (const listener of listeners) listener(); },
  };
}
function useSource<T>(source: ReturnType<typeof observable<T>>) {
  return (selector: (value: T) => unknown) => selector(React.useSyncExternalStore(source.subscribe, source.getSnapshot));
}

// The test uses the actual bundled browser half and real React. Only the
// platform UI seed is replaced, because settings chrome is outside this test.
async function browserPlugin() {
  const output = await build({
    entryPoints: ['src/client.tsx'], bundle: true, write: false, format: 'cjs', platform: 'browser',
    external: ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  });
  const module = { exports: {} as AnyRecord };
  const require = createRequire(import.meta.url);
  class SettingsFormModel {
    bind(project: () => unknown) { return { getSnapshot: project, subscribe: () => () => {} }; }
    shell() { return { available: true, writable: true, dirty: false, saving: false, failed: false, invalid: false }; }
    field() { return { text: '', overridden: false, invalid: false }; }
    actions() { return { edit() {}, resetField() {}, save() {}, discard() {} }; }
    dispose() {}
  }
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports, AbortController, setTimeout, clearTimeout,
    require: (id: string) => id === '@deepseek-ai/dsh-client-ui-primitives'
      ? { SettingsFormModel, SettingsForm: () => null, SettingsValueField: () => null } : require(id),
  });
  return module.exports;
}

async function harness() {
  const plugin = await browserPlugin();
  const window = new Window();
  const before = Object.getOwnPropertyDescriptors(globalThis);
  for (const [key, value] of Object.entries({ window, document: window.document, navigator: window.navigator,
    HTMLElement: window.HTMLElement, Node: window.Node, MutationObserver: window.MutationObserver })) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = window.document.createElement('div');
  window.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const bindings = new Map<string, AnyRecord>();
  const catalog = observable({ phase: 'ready', ids: [] as string[], byId: {} as AnyRecord });
  const registration = new Map<string, AnyRecord>();
  const config = observable({ value: { ...DEFAULT_CONFIG }, status: 'ready', writable: true, revision: 1 });
  const status = observable(new Map<string, AnyRecord>());
  const requests: { payload: AnyRecord; signal: AbortSignal; finish: (text: string) => void }[] = [];
  const cleanups: (() => void)[] = [];
  plugin.apply({
    locale: { register: () => () => {} },
    effect: (effect: () => () => void) => { cleanups.push(effect()); },
    configForms: { get: () => config },
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (options: AnyRecord, component: React.ComponentType<any>) => {
        registration.set(options.name, { options, component }); return () => {};
      },
    },
    sessions: { binding: (id: string) => bindings.get(id), list: catalog },
    conversation: { input: { for: (ctx: AnyRecord) => ({ state: ctx.input }) } },
    uiSession: { sessionStatus: status },
    connection: { rpc: { call: (_channel: string, _endpoint: string, payload: AnyRecord, signal: AbortSignal) =>
      new Promise((resolve) => requests.push({ payload, signal, finish: (suggestion) => resolve({
        ok: true, value: { ...payload, suggestion, generatedAt: Date.now() },
      }) })) } },
  });
  const overlay = registration.get('conversation.input.overlay')!;
  function addSession(id: string, seq: number) {
    const session = observable({ sessionId: id, running: false, removed: false, openState: 'open',
      awaitingFirstTurn: false, pendingSubmissions: [], subagent: null });
    const input = observable({ draft: '', draftRev: 1, attachmentIds: [], occurrences: [], phase: 'plain', queue: [] });
    const eventSource = observable({ entries: [{ type: 'event', event: { type: 'turn/end', seq, data: {}, time: 1 } }] });
    const binding = { sessionId: id, session, eventSource, ctx: { input } };
    const actions = {
      captureInsertion: () => ({ start: 0, end: 0, draftRev: input.getSnapshot().draftRev }),
      insertText: (text: string, span: { draftRev: number }) => {
        const current = input.getSnapshot();
        if (current.draft !== '' || current.draftRev !== span.draftRev || current.phase !== 'plain') return false;
        input.set({ ...current, draft: text, draftRev: current.draftRev + 1 }); return true;
      },
    };
    bindings.set(id, { ...binding, actions });
    catalog.set({ ...catalog.getSnapshot(), ids: [...new Set([...catalog.getSnapshot().ids, id])],
      byId: { ...catalog.getSnapshot().byId, [id]: { id } } });
    return { session, input, eventSource };
  }
  function Composer({ id }: { id: string }) {
    const binding = bindings.get(id)!;
    const face = overlay.options.inject(id);
    const props = {
      sessionId: id, inputActions: binding.actions,
      useInput: useSource(binding.ctx.input), useSession: useSource(binding.session), useSessionStatus: useSource(status),
      useRound: useSource(face.hooks.round), useConfig: useSource(config),
      fetchSuggestion: face.fetchSuggestion, isCurrentRound: face.isCurrentRound,
      hasOptedOut: face.hasOptedOut, optOut: face.optOut,
    };
    return React.createElement('div', { 'data-composer-card': true },
      React.createElement('div', null, React.createElement(overlay.component, props)),
      React.createElement('div', { 'data-composer-input': true, contentEditable: true,
        'data-placeholder': 'Default', 'aria-label': 'Default', suppressContentEditableWarning: true }),
      React.createElement('div', { 'data-composer-placeholder': true }, 'Default'));
  }
  const render = (id: string, strict = true) => flushSync(() => root.render(
    strict ? React.createElement(React.StrictMode, null, React.createElement(Composer, { id }))
      : React.createElement(Composer, { id })));
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await window.happyDOM.waitUntilComplete();
  };
  return {
    window, bindings, requests, status, config, addSession, render, settle,
    removeSession(id: string) {
      bindings.delete(id);
      const byId = { ...catalog.getSnapshot().byId };
      delete byId[id];
      catalog.set({ ...catalog.getSnapshot(), ids: catalog.getSnapshot().ids.filter(value => value !== id), byId });
    },
    get editor() { return container.querySelector('[data-composer-input]')!; },
    get placeholder() { return container.querySelector('[data-composer-placeholder]')!.textContent; },
    tab() {
      const event = new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      container.querySelector('[data-composer-input]')!.dispatchEvent(event); return event;
    },
    close() {
      flushSync(() => root.unmount());
      for (const cleanup of cleanups.reverse()) cleanup?.();
      for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver']) {
        if (before[key]) Object.defineProperty(globalThis, key, before[key]);
        else Reflect.deleteProperty(globalThis, key);
      }
      window.happyDOM.abort();
    },
  };
}

test('real React StrictMode keeps the replayed composer live and sends only four wire fields', async () => {
  const h = await harness();
  try {
    const session = h.addSession('A', 10);
    h.render('A');
    await h.settle();
    const latest = h.requests.at(-1)!;
    assert.ok(latest.payload.requestId >= 2, 'StrictMode cancels the initial attempt before replay');
    assert.deepEqual(Object.keys(latest.payload).sort(), ['requestId', 'requestedAt', 'roundId', 'sessionId']);
    latest.finish('Current reply');
    await h.settle();
    assert.equal(h.placeholder, 'Current reply');
    assert.equal(h.tab().defaultPrevented, true);
    assert.equal(session.input.getSnapshot().draft, 'Current reply');
    assert.equal(h.placeholder, 'Default');
  } finally { h.close(); }
});

test('session switching cancels old replies and resets an unfinished IME composition', async () => {
  const h = await harness();
  try {
    h.addSession('A', 10);
    const b = h.addSession('B', 20);
    h.render('A');
    await h.settle();
    const old = h.requests.at(-1)!;
    h.editor.dispatchEvent(new h.window.Event('compositionstart', { bubbles: true }));
    h.render('B');
    await h.settle();
    const latest = h.requests.at(-1)!;
    assert.equal(latest.payload.sessionId, 'B');
    assert.equal(old.signal.aborted, true);
    old.finish('Old session reply');
    latest.finish('New session reply');
    await h.settle();
    assert.equal(h.placeholder, 'New session reply');
    assert.equal(h.tab().defaultPrevented, true);
    assert.equal(b.input.getSnapshot().draft, 'New session reply');
  } finally { h.close(); }
});

test('live store guards reject Tab and responses before a React render catches up', async () => {
  const h = await harness();
  try {
    const a = h.addSession('A', 10);
    h.render('A');
    await h.settle();
    h.requests.at(-1)!.finish('Suggested reply');
    await h.settle();
    assert.equal(h.placeholder, 'Suggested reply');
    a.session.set({ ...a.session.getSnapshot(), running: true });
    assert.equal(h.tab().defaultPrevented, false);
    assert.equal(a.input.getSnapshot().draft, '');
    await h.settle();
    assert.equal(h.placeholder, 'Default');
    a.session.set({ ...a.session.getSnapshot(), running: false });
    a.eventSource.set({ entries: [{ type: 'event', event: { type: 'turn/end', seq: 30, data: {}, time: 2 } }] });
    await h.settle();
    const next = h.requests.at(-1)!;
    a.input.set({ ...a.input.getSnapshot(), draft: 'manual ', draftRev: 2 });
    next.finish('Late reply');
    await h.settle();
    assert.equal(h.placeholder, 'Default');
    assert.equal(h.tab().defaultPrevented, false);
    assert.equal(a.input.getSnapshot().draft, 'manual ');
  } finally { h.close(); }
});

test('new completed rounds and settings changes start clean and discard earlier results', async () => {
  const h = await harness();
  try {
    const a = h.addSession('A', 10);
    h.render('A');
    await h.settle();
    const previous = h.requests.at(-1)!;
    a.eventSource.set({ entries: [{ type: 'event', event: { type: 'turn/end', seq: 20, data: {}, time: 2 } }] });
    await h.settle();
    assert.equal(h.placeholder, 'Default');
    const current = h.requests.at(-1)!;
    assert.equal(current.payload.roundId, '20');
    previous.finish('Earlier round');
    current.finish('Current round');
    await h.settle();
    assert.equal(h.placeholder, 'Current round');
    h.config.set({ ...h.config.getSnapshot(), value: { ...DEFAULT_CONFIG, maxSuggestionChars: 100 } });
    await h.settle();
    assert.equal(h.placeholder, 'Default');
    h.requests.at(-1)!.finish('After settings change');
    await h.settle();
    assert.equal(h.placeholder, 'After settings change');
  } finally { h.close(); }
});

test('waits for configuration readiness and a disabling write blocks Tab immediately', async () => {
  const h = await harness();
  try {
    h.addSession('A', 10);
    h.config.set({ ...h.config.getSnapshot(), status: 'loading' });
    h.render('A');
    await h.settle();
    assert.equal(h.requests.length, 0);
    h.config.set({ ...h.config.getSnapshot(), status: 'ready' });
    await h.settle();
    h.requests.at(-1)!.finish('Suggested reply');
    await h.settle();
    assert.equal(h.placeholder, 'Suggested reply');
    h.config.set({ ...h.config.getSnapshot(), value: { ...DEFAULT_CONFIG, enabled: false } });
    assert.equal(h.tab().defaultPrevented, false);
    await h.settle();
    assert.equal(h.placeholder, 'Default');
  } finally { h.close(); }
});

test('manual input followed by deletion stays opted out across configuration and Session changes', async () => {
  const h = await harness();
  try {
    const a = h.addSession('A', 10);
    h.addSession('B', 20);
    h.render('A');
    await h.settle();
    h.editor.dispatchEvent(new h.window.Event('beforeinput', { bubbles: true }));
    a.input.set({ ...a.input.getSnapshot(), draft: 'manual reply', draftRev: 2 });
    await h.settle();
    a.input.set({ ...a.input.getSnapshot(), draft: '', draftRev: 3 });
    await h.settle();
    const aRequestCount = () => h.requests.filter(request => request.payload.sessionId === 'A').length;
    const previousCount = aRequestCount();
    h.config.set({ ...h.config.getSnapshot(), value: { ...DEFAULT_CONFIG, maxSuggestionChars: 100 } });
    await h.settle();
    assert.equal(aRequestCount(), previousCount);
    assert.equal(h.placeholder, 'Default');
    assert.equal(h.tab().defaultPrevented, false);
    h.render('B');
    await h.settle();
    h.render('A');
    await h.settle();
    assert.equal(aRequestCount(), previousCount);
    assert.equal(h.placeholder, 'Default');
    assert.equal(h.tab().defaultPrevented, false);
    a.eventSource.set({ entries: [{ type: 'event', event: { type: 'turn/end', seq: 30, data: {}, time: 2 } }] });
    await h.settle();
    assert.equal(aRequestCount(), previousCount + 1);
    h.requests.at(-1)!.finish('A new round reply');
    await h.settle();
    assert.equal(h.placeholder, 'A new round reply');
    assert.equal(h.tab().defaultPrevented, true);
  } finally { h.close(); }
});

test('accepted suggestions stay consumed after deletion and a Session generation remount', async () => {
  const h = await harness();
  try {
    const a = h.addSession('A', 10);
    h.addSession('B', 20);
    h.render('A');
    await h.settle();
    h.requests.at(-1)!.finish('Accepted reply');
    await h.settle();
    assert.equal(h.tab().defaultPrevented, true);
    await h.settle();
    a.input.set({ ...a.input.getSnapshot(), draft: '', draftRev: 3 });
    await h.settle();
    const previousCount = h.requests.filter(request => request.payload.sessionId === 'A').length;
    h.render('B');
    await h.settle();
    h.addSession('A', 10); // A new Client binding for the same durable round.
    h.render('A');
    await h.settle();
    assert.equal(h.requests.filter(request => request.payload.sessionId === 'A').length, previousCount);
    assert.equal(h.placeholder, 'Default');
    assert.equal(h.tab().defaultPrevented, false);
    h.render('B');
    await h.settle();
    h.removeSession('A'); // Deleted catalog entries must release their marker.
    h.addSession('A', 10);
    h.render('A');
    await h.settle();
    assert.equal(h.requests.filter(request => request.payload.sessionId === 'A').length, previousCount + 1);
  } finally { h.close(); }
});

test('native manual input opts out of the actual completed round before React renders it', async () => {
  const h = await harness();
  try {
    const a = h.addSession('A', 10);
    h.render('A');
    await h.settle();
    const previousCount = h.requests.length;
    // React has not rendered round 20 when the native editor receives input.
    a.eventSource.set({ entries: [{ type: 'event', event: { type: 'turn/end', seq: 20, data: {}, time: 2 } }] });
    h.editor.dispatchEvent(new h.window.Event('beforeinput', { bubbles: true }));
    a.input.set({ ...a.input.getSnapshot(), draft: 'typed', draftRev: 2 });
    a.input.set({ ...a.input.getSnapshot(), draft: '', draftRev: 3 });
    await h.settle();
    assert.equal(h.requests.length, previousCount);
    assert.equal(h.placeholder, 'Default');
    assert.equal(h.tab().defaultPrevented, false);
    h.config.set({ ...h.config.getSnapshot(), value: { ...DEFAULT_CONFIG, maxSuggestionChars: 100 } });
    await h.settle();
    assert.equal(h.requests.length, previousCount);
    // A later completed round still starts from a fresh decision.
    a.eventSource.set({ entries: [{ type: 'event', event: { type: 'turn/end', seq: 30, data: {}, time: 3 } }] });
    await h.settle();
    assert.equal(h.requests.length, previousCount + 1);
    assert.equal(h.requests.at(-1)!.payload.roundId, '30');
  } finally { h.close(); }
});
