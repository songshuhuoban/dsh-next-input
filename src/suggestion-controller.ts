/** State supplied by the composer. A round changes when new conversation work begins. */
export interface SuggestionContext {
  sessionId: string;
  roundId: string;
  idle: boolean;
  enabled: boolean;
  text: string;
  composing: boolean;
}

/** Retries share the same requestId and requestedAt; attempt starts at zero. */
export interface SuggestionRequest {
  readonly sessionId: string;
  readonly roundId: string;
  readonly requestId: number;
  readonly requestedAt: number;
  readonly attempt: number;
}

export interface SuggestionSnapshot {
  readonly suggestion: string | null;
  readonly requestId?: number;
  readonly requestedAt?: number;
  readonly generatedAt?: number;
}

export type FetchSuggestion = (
  request: SuggestionRequest,
  signal: AbortSignal,
) => Promise<string | null> | string | null;

export interface SuggestionControllerOptions {
  /** Number of retries after the initial attempt. Defaults to three. */
  maxRetries?: number;
  retryDelayMs?: number;
  /** Timeout for each attempt, including a provider that ignores cancellation. */
  timeoutMs?: number;
  /** Clock injection is useful for testing; ordering always uses requestId. */
  now?: () => number;
}

interface PendingRequest {
  readonly sessionId: string;
  readonly roundId: string;
  readonly requestId: number;
  readonly requestedAt: number;
  readonly controller: AbortController;
}

const EMPTY_SNAPSHOT: SuggestionSnapshot = Object.freeze({ suggestion: null });
const CANCELLED = Symbol("cancelled");
const TIMED_OUT = Symbol("timed out");

function integerOrDefault(value: number | undefined, fallback: number, minimum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

/**
 * One controller belongs to one composer. All invalidation happens synchronously.
 * Once the user types anything, this round stays suppressed even if they erase it.
 * That prevents a late response or an automatic refresh from taking over their input.
 */
export class SuggestionController {
  private context: Readonly<SuggestionContext> | undefined;
  private snapshot: SuggestionSnapshot = EMPTY_SNAPSHOT;
  private pending: PendingRequest | undefined;
  private sequence = 0;
  private suppressedForRound = false;
  private disposed = false;
  private readonly listeners = new Set<() => void>();
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(
    private readonly fetchSuggestion: FetchSuggestion,
    options: SuggestionControllerOptions = {},
  ) {
    this.maxRetries = integerOrDefault(options.maxRetries, 3, 0);
    this.retryDelayMs = integerOrDefault(options.retryDelayMs, 250, 0);
    this.timeoutMs = integerOrDefault(options.timeoutMs, 15_000, 1);
    this.now = options.now ?? Date.now;
  }

  /** Arrow functions can be passed directly to useSyncExternalStore. */
  readonly getSnapshot = (): SuggestionSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update(context: SuggestionContext): void {
    if (this.disposed) return;
    const wasEligible = this.isEligible();
    const newRound = !this.context
      || this.context.sessionId !== context.sessionId
      || this.context.roundId !== context.roundId;

    this.context = Object.freeze({ ...context });
    if (newRound) this.suppressedForRound = false;
    if (context.text !== "") this.suppressedForRound = true;

    if (newRound || !this.isEligible()) this.invalidate();
    if (this.isEligible() && (newRound || !wasEligible)) this.startRequest();
  }

  /** Explicitly replaces the current request or suggestion in the same round. */
  refresh(): boolean {
    if (!this.isEligible()) return false;
    this.startRequest();
    return true;
  }

  /** Returns text only when Tab is safe to consume; callers insert it themselves. */
  accept(): string | null {
    if (!this.isEligible()
      || this.snapshot.requestId !== this.sequence
      || !this.snapshot.suggestion) return null;

    const text = this.snapshot.suggestion;
    this.suppressedForRound = true;
    this.invalidate();
    return text;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    this.listeners.clear();
  }

  private isEligible(): boolean {
    return !this.disposed
      && !!this.context
      && this.context.enabled
      && this.context.idle
      && this.context.text === ""
      && !this.context.composing
      && !this.suppressedForRound;
  }

  private isCurrent(request: PendingRequest): boolean {
    return this.pending === request
      && request.requestId === this.sequence
      && this.context?.sessionId === request.sessionId
      && this.context.roundId === request.roundId
      && this.isEligible();
  }

  private invalidate(): void {
    const previous = this.pending;
    this.pending = undefined;
    // Assign the empty state before abortion can invoke provider callbacks.
    const changed = this.snapshot !== EMPTY_SNAPSHOT;
    this.snapshot = EMPTY_SNAPSHOT;
    previous?.controller.abort();
    if (changed) this.notify();
  }

  private startRequest(): void {
    this.invalidate();
    if (!this.context || !this.isEligible()) return;
    const request: PendingRequest = {
      sessionId: this.context.sessionId,
      roundId: this.context.roundId,
      requestId: ++this.sequence,
      requestedAt: this.now(),
      controller: new AbortController(),
    };
    this.pending = request;
    this.publish({
      suggestion: null,
      requestId: request.requestId,
      requestedAt: request.requestedAt,
    });
    // execute handles provider errors, cancellations, timeouts, and late rejections.
    void this.execute(request);
  }

  private async execute(request: PendingRequest): Promise<void> {
    try {
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (!this.isCurrent(request)) return;
        try {
          const value = await this.runAttempt(request, attempt);
          if (!this.isCurrent(request)) return;
          this.pending = undefined;
          const suggestion = typeof value === "string" ? value.trim() : "";
          if (!suggestion) {
            this.publish(EMPTY_SNAPSHOT);
            return;
          }
          this.publish({
            suggestion,
            requestId: request.requestId,
            requestedAt: request.requestedAt,
            generatedAt: this.now(),
          });
          return;
        } catch {
          if (!this.isCurrent(request)) return;
          if (attempt === this.maxRetries) {
            this.pending = undefined;
            this.publish(EMPTY_SNAPSHOT);
            return;
          }
          await this.waitForRetry(request);
        }
      }
    } catch {
      // Cancellation during a retry delay is intentionally silent.
      if (this.isCurrent(request)) {
        this.pending = undefined;
        this.publish(EMPTY_SNAPSHOT);
      }
    }
  }

  private runAttempt(request: PendingRequest, attempt: number): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (complete: () => void) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        request.controller.signal.removeEventListener("abort", onAbort);
        complete();
      };
      const onAbort = () => {
        controller.abort();
        settle(() => reject(CANCELLED));
      };
      request.controller.signal.addEventListener("abort", onAbort, { once: true });
      if (request.controller.signal.aborted || !this.isCurrent(request)) {
        onAbort();
        return;
      }
      timer = setTimeout(() => {
        controller.abort();
        settle(() => reject(TIMED_OUT));
      }, this.timeoutMs);
      const metadata: SuggestionRequest = Object.freeze({
        sessionId: request.sessionId,
        roundId: request.roundId,
        requestId: request.requestId,
        requestedAt: request.requestedAt,
        attempt,
      });
      // Installing both handlers consumes rejections even after abort or timeout.
      Promise.resolve()
        .then(() => {
          if (controller.signal.aborted || !this.isCurrent(request)) throw CANCELLED;
          return this.fetchSuggestion(metadata, controller.signal);
        })
        .then(
          value => settle(() => resolve(value)),
          error => settle(() => reject(error)),
        );
    });
  }

  private waitForRetry(request: PendingRequest): Promise<void> {
    if (!this.isCurrent(request)) return Promise.reject(CANCELLED);
    if (this.retryDelayMs === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(CANCELLED);
      };
      const timer = setTimeout(() => {
        request.controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, this.retryDelayMs);
      request.controller.signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private publish(snapshot: SuggestionSnapshot): void {
    this.snapshot = snapshot === EMPTY_SNAPSHOT ? EMPTY_SNAPSHOT : Object.freeze(snapshot);
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener(); } catch { /* Consumer errors must not reject a background task. */ }
    }
  }
}
