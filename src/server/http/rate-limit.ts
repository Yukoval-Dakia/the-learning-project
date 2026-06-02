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
 * current timestamp to the window and returns.
 *
 * @param now injectable clock (ms since epoch) for deterministic tests.
 */
export function checkRateLimit(now: number = Date.now()): void {
  const { max, windowMs } = resolveConfig();
  const windowStart = now - windowMs;

  // Evict expired hits from the front (timestamps are appended in order).
  let firstFresh = 0;
  while (firstFresh < hits.length && hits[firstFresh] <= windowStart) {
    firstFresh++;
  }
  if (firstFresh > 0) hits.splice(0, firstFresh);

  if (hits.length >= max) {
    throw new ApiError(
      'rate_limited',
      `AI request rate limit exceeded: max ${max} requests per ${windowMs}ms`,
      429,
    );
  }

  hits.push(now);
}

/** Test-only: clears the singleton window so tests don't bleed into each other. */
export function __resetRateLimitForTests(): void {
  hits.length = 0;
}
