import { getConfigMany } from '@/core/config/store';
import { ApiError } from './errors';

// In-process rate limiter for the AI funnel.
//
// Threat model: this is a single-user self-hosted tool with no per-user/per-IP auth
// boundary, so the risk is a runaway client or buggy loop hammering the AI endpoint
// and burning the paid, metered model budget. One global sliding window over
// wall-clock time is sufficient — hits are intentionally not keyed by IP or user.
//
// State lives in a module-level singleton, so it persists across requests within one
// Node process but does not coordinate across processes. That is acceptable: the
// worker never hits this route, and the guard only needs to cap the app's AI funnel.

const DEFAULT_MAX = 30;
const DEFAULT_WINDOW_MS = 10_000;

function _readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export function resolveConfig(): { max: number; windowMs: number } {
  // DB > env > code default（env 层保留原正整数语义）。
  const cfg = getConfigMany(['AI_RATE_LIMIT_MAX', 'AI_RATE_LIMIT_WINDOW_MS']);
  return {
    max: typeof cfg.AI_RATE_LIMIT_MAX === 'number' ? cfg.AI_RATE_LIMIT_MAX : DEFAULT_MAX,
    windowMs:
      typeof cfg.AI_RATE_LIMIT_WINDOW_MS === 'number'
        ? cfg.AI_RATE_LIMIT_WINDOW_MS
        : DEFAULT_WINDOW_MS,
  };
}

const hits: number[] = [];

/**
 * Record one AI-funnel hit against the global sliding window.
 *
 * Throws an {@link ApiError} with HTTP 429 when the hit would exceed
 * `AI_RATE_LIMIT_MAX`. On success appends `now` and returns it as the token that
 * {@link refundRateLimit} can hand back when the work it was reserved for never ran.
 *
 * @param now injectable clock (ms since epoch) for deterministic tests.
 */
export function checkRateLimit(now: number = Date.now()): number {
  const { max, windowMs } = resolveConfig();
  const windowStart = now - windowMs;

  let firstFresh = 0;
  while (firstFresh < hits.length && hits[firstFresh] <= windowStart) {
    firstFresh++;
  }
  if (firstFresh > 0) hits.splice(0, firstFresh);

  if (hits.length >= max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((hits[0] + windowMs - now) / 1000));
    throw new ApiError(
      'rate_limited',
      `AI request rate limit exceeded: max ${max} requests per ${windowMs}ms`,
      429,
      { 'Retry-After': String(retryAfterSeconds) },
    );
  }

  hits.push(now);
  return now;
}

/**
 * Hand a token back when the paid work it was reserved for never happened.
 *
 * The window is a pre-paid reservation: callers that gate before dispatching would
 * otherwise burn budget on every failed dispatch, and a client retry loop over a
 * transient failure could drain the whole window and lock out unrelated AI calls.
 * Only the caller that owns a token may refund it, and only when no paid work
 * started. No-op once the token is evicted — a refund is best-effort bookkeeping.
 */
export function refundRateLimit(token: number): void {
  const idx = hits.lastIndexOf(token);
  if (idx >= 0) hits.splice(idx, 1);
}

/** Test-only: clears the singleton window so tests don't bleed into each other. */
export function __resetRateLimitForTests(): void {
  hits.length = 0;
}
