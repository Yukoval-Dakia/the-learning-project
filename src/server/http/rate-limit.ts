import { ApiError } from './errors';

// YUK-138 [M2]: In-process rate limiter for the AI funnel.
//
// Threat model: this is a single-user self-hosted tool. There is no per-user /
// per-IP auth boundary, so the risk we guard against is a runaway client or a
// buggy loop hammering the AI endpoint and burning the (paid, metered) model
// budget. A single global sliding window over wall-clock time is sufficient —
// we intentionally do NOT key by IP or user.
//
// Sliding-window log: keep the timestamps of the most recent allowed hits and
// drop any that fall outside the current window on each check. No new deps;
// state lives in a module-level singleton so it persists across requests within
// a single Node process (the runtime is self-hosted Node, not per-request
// serverless — see CLAUDE.md stack note). It does NOT coordinate across
// processes (app vs worker), which is acceptable: the worker doesn't hit this
// route, and the budget guard only needs to cap the app's AI funnel.

const DEFAULT_MAX = 30;
const DEFAULT_WINDOW_MS = 10_000;

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function resolveConfig(): { max: number; windowMs: number } {
  return {
    max: readPositiveInt(process.env.AI_RATE_LIMIT_MAX, DEFAULT_MAX),
    windowMs: readPositiveInt(process.env.AI_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS),
  };
}

// Module-level singleton window state: the sorted-ascending timestamps (ms) of
// hits still inside the current window.
const hits: number[] = [];

/**
 * Record one AI-funnel hit against the global sliding window.
 *
 * Throws an {@link ApiError} with HTTP 429 when the number of hits within the
 * trailing window would exceed `AI_RATE_LIMIT_MAX`. On success it appends the
 * current timestamp to the window and returns that timestamp — the token, which
 * {@link refundRateLimit} can hand back when the work it was spent on never happened.
 *
 * @param now injectable clock (ms since epoch) for deterministic tests.
 * @returns the recorded timestamp (the refundable token).
 */
export function checkRateLimit(now: number = Date.now()): number {
  const { max, windowMs } = resolveConfig();
  const windowStart = now - windowMs;

  // Evict expired hits from the front (timestamps are appended in order).
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
 * YUK-594 (W4) — hand a token back when the paid work it was reserved for never happened.
 *
 * The window is a pre-paid reservation: callers that gate BEFORE dispatching (so a 429 is
 * raised before anything is enqueued) would otherwise burn budget on every failed dispatch,
 * and a client retry loop over a transient failure could drain the whole window and lock out
 * unrelated AI calls. Only the caller that owns a token may refund it, and only on a path
 * where no paid work was started.
 *
 * No-op when the token is no longer in the window (already evicted by age) — a refund is
 * best-effort bookkeeping, never an error.
 */
export function refundRateLimit(token: number): void {
  const idx = hits.lastIndexOf(token);
  if (idx >= 0) hits.splice(idx, 1);
}

/** Test-only: clears the singleton window so tests don't bleed into each other. */
export function __resetRateLimitForTests(): void {
  hits.length = 0;
}
