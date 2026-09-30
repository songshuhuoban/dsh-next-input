import assert from "node:assert/strict";
import test from "node:test";
import {
  SuggestionController,
  type SuggestionContext,
  type SuggestionRequest,
} from "../src/suggestion-controller.js";

const base: SuggestionContext = {
  sessionId: "session-a",
  roundId: "round-1",
  idle: true,
  enabled: true,
  text: "",
  composing: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  // Drain the provider and controller continuations without timing assumptions.
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

async function eventually(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("condition did not become true");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

test("the newest logical request wins even if cancellation is ignored and timestamps tie", async () => {
  const requests: Array<{ metadata: SuggestionRequest; signal: AbortSignal; result: ReturnType<typeof deferred<string>> }> = [];
  const controller = new SuggestionController((metadata, signal) => {
    const result = deferred<string>();
    requests.push({ metadata, signal, result });
    return result.promise;
  }, { now: () => 100, timeoutMs: 1_000 });
  try {
    controller.update(base);
    await flush();
    controller.refresh();
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[0].signal.aborted, true);
    assert.equal(Object.isFrozen(requests[1].metadata), true);
    assert.ok(requests[1].metadata.requestId > requests[0].metadata.requestId);
    requests[1].result.resolve("Latest response");
    await flush();
    const latest = controller.getSnapshot();
    assert.equal(latest.suggestion, "Latest response");
    assert.equal(latest.requestedAt, 100);
    assert.equal(latest.generatedAt, 100);
    requests[0].result.resolve("Old response");
    await flush();
    assert.equal(controller.getSnapshot(), latest);
    controller.update({ ...base });
    assert.equal(controller.getSnapshot(), latest, "unchanged context preserves snapshot identity");
  } finally { controller.dispose(); }
});

test("typing invalidates immediately and erasing input does not revive the same round", async () => {
  const first = deferred<string>();
  let calls = 0;
  let signal!: AbortSignal;
  const controller = new SuggestionController((_request, attemptSignal) => {
    calls++;
    signal = attemptSignal;
    return first.promise;
  });
  try {
    controller.update(base);
    await flush();
    controller.update({ ...base, text: "manual" });
    assert.equal(controller.getSnapshot().suggestion, null);
    assert.equal(signal.aborted, true);
    assert.equal(controller.accept(), null);
    controller.update({ ...base, text: "" });
    assert.equal(controller.refresh(), false);
    first.resolve("Stale response");
    await flush();
    assert.equal(controller.getSnapshot().suggestion, null);
    assert.equal(calls, 1);
    controller.update({ ...base, roundId: "round-2" });
    await flush();
    assert.equal(calls, 2);
    assert.equal(controller.getSnapshot().suggestion, "Stale response");
  } finally { controller.dispose(); }
});

test("busy, round, and session changes clear ready text and abort pending work", async () => {
  const requests: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred<string>> }> = [];
  const controller = new SuggestionController((_request, signal) => {
    const result = deferred<string>();
    requests.push({ signal, result });
    return result.promise;
  });
  try {
    controller.update(base);
    await flush();
    requests[0].result.resolve("Round one");
    await flush();
    controller.update({ ...base, idle: false });
    assert.equal(controller.getSnapshot().suggestion, null);
    controller.update(base);
    await flush();
    controller.update({ ...base, roundId: "round-2" });
    assert.equal(requests[1].signal.aborted, true);
    assert.equal(controller.getSnapshot().suggestion, null);
    await flush();
    controller.update({ ...base, sessionId: "session-b", roundId: "round-2" });
    assert.equal(requests[2].signal.aborted, true);
    await flush();
    requests[3].result.resolve("Current session");
    requests[1].result.resolve("Old busy transition");
    requests[2].result.resolve("Old session");
    await flush();
    assert.equal(controller.getSnapshot().suggestion, "Current session");
  } finally { controller.dispose(); }
});

test("three default retries share logical metadata and failures leave the default state", async () => {
  const requests: SuggestionRequest[] = [];
  const controller = new SuggestionController(request => {
    requests.push(request);
    throw new Error("provider unavailable");
  }, { retryDelayMs: 0 });
  try {
    controller.update(base);
    await eventually(() => requests.length === 4 && controller.getSnapshot().requestId === undefined);
    assert.deepEqual(requests.map(request => request.attempt), [0, 1, 2, 3]);
    assert.equal(new Set(requests.map(request => request.requestId)).size, 1);
    assert.equal(new Set(requests.map(request => request.requestedAt)).size, 1);
    assert.deepEqual(controller.getSnapshot(), { suggestion: null });
    controller.update({ ...base });
    await flush();
    assert.equal(requests.length, 4, "a failed request does not loop automatically");
  } finally { controller.dispose(); }
});

test("a successful retry publishes only its current request", async () => {
  let calls = 0;
  const controller = new SuggestionController(async () => {
    if (++calls < 3) throw new Error("temporary");
    return "Recovered suggestion";
  }, { retryDelayMs: 0 });
  try {
    controller.update(base);
    await eventually(() => controller.getSnapshot().suggestion !== null);
    assert.equal(calls, 3);
    assert.equal(controller.getSnapshot().suggestion, "Recovered suggestion");
  } finally { controller.dispose(); }
});

test("timeouts abort attempts, exhaust retries, and consume late provider rejections", async () => {
  const attempts: Array<{ signal: AbortSignal; result: ReturnType<typeof deferred<string>> }> = [];
  const controller = new SuggestionController((_request, signal) => {
    const result = deferred<string>();
    attempts.push({ signal, result });
    return result.promise;
  }, { timeoutMs: 5, retryDelayMs: 0, maxRetries: 1 });
  try {
    controller.update(base);
    await eventually(() => attempts.length === 2 && controller.getSnapshot().requestId === undefined);
    assert.ok(attempts.every(attempt => attempt.signal.aborted));
    attempts[0].result.reject(new Error("late rejection"));
    attempts[1].result.resolve("Too late");
    await flush();
    assert.deepEqual(controller.getSnapshot(), { suggestion: null });
  } finally { controller.dispose(); }
});

test("disposing during a retry delay cancels the timer and all future attempts", async () => {
  let calls = 0;
  const controller = new SuggestionController(() => {
    calls++;
    throw new Error("retry me");
  }, { retryDelayMs: 20 });
  controller.update(base);
  await flush();
  assert.equal(calls, 1);
  controller.dispose();
  controller.update({ ...base, roundId: "round-2" });
  assert.equal(controller.refresh(), false);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(calls, 1);
  assert.deepEqual(controller.getSnapshot(), { suggestion: null });
});

test("disposing pending work aborts it and prevents notifications from a late result", async () => {
  const result = deferred<string>();
  let signal!: AbortSignal;
  const controller = new SuggestionController((_request, attemptSignal) => {
    signal = attemptSignal;
    return result.promise;
  });
  let notifications = 0;
  controller.subscribe(() => notifications++);
  controller.update(base);
  await flush();
  controller.dispose();
  const atDispose = notifications;
  assert.equal(signal.aborted, true);
  result.resolve("Disposed result");
  await flush();
  assert.equal(notifications, atDispose);
  assert.equal(controller.accept(), null);
});

test("acceptance requires exact emptiness, an idle enabled round, and no IME composition", async () => {
  const controller = new SuggestionController(() => "Use this answer", { retryDelayMs: 0 });
  try {
    controller.update(base);
    await flush();
    assert.equal(controller.accept(), "Use this answer");
    assert.equal(controller.accept(), null);
    assert.equal(controller.getSnapshot().suggestion, null);
    assert.equal(controller.refresh(), false);
    controller.update({ ...base, roundId: "round-2" });
    await flush();
    controller.update({ ...base, roundId: "round-2", text: " " });
    assert.equal(controller.accept(), null);
    controller.update({ ...base, roundId: "round-3", composing: true });
    await flush();
    assert.equal(controller.accept(), null);
    controller.update({ ...base, roundId: "round-3", composing: false });
    await flush();
    assert.equal(controller.getSnapshot().suggestion, "Use this answer");
    controller.update({ ...base, roundId: "round-3", enabled: false });
    assert.equal(controller.accept(), null);
    controller.update({ ...base, roundId: "round-3", idle: false });
    assert.equal(controller.accept(), null);
  } finally { controller.dispose(); }
});

test("empty provider output is discarded silently without retrying", async () => {
  let calls = 0;
  const controller = new SuggestionController(() => { calls++; return " \n "; });
  try {
    controller.update(base);
    await flush();
    assert.equal(calls, 1);
    assert.deepEqual(controller.getSnapshot(), { suggestion: null });
  } finally { controller.dispose(); }
});
