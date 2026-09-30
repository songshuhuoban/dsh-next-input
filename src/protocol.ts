/** Shared, JSON-only contract. No Host runtime imports in the browser. */
export const CONFIG_NS = 'next-input';
export const RPC_ENDPOINT = 'next-input/suggest';

export interface NextInputConfig {
  enabled: boolean;
  /** Additional attempts after the initial request. */
  maxRetries: number;
  /** Timeout of each attempt in milliseconds. */
  timeoutMs: number;
  maxSuggestionChars: number;
}

export const DEFAULT_CONFIG: Readonly<NextInputConfig> = Object.freeze({
  enabled: true,
  maxRetries: 3,
  timeoutMs: 15_000,
  maxSuggestionChars: 240,
});

export interface SuggestionRequest {
  sessionId: string;
  /** Sequence of the newest completed turn, encoded as a decimal string. */
  roundId: string;
  requestId: number;
  requestedAt: number;
}

export interface SuggestionResponse extends SuggestionRequest {
  suggestion: string | null;
  generatedAt: number;
}
