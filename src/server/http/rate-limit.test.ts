import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, errorResponse } from './errors';
import { __resetRateLimitForTests, checkRateLimit, refundRateLimit } from './rate-limit';

describe('checkRateLimit', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    vi.stubEnv('AI_RATE_LIMIT_MAX', '3');
    vi.stubEnv('AI_RATE_LIMIT_WINDOW_MS', '1000');
  });

  afterEach(() => {
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('allows requests up to the configured max within a window', () => {
    const now = 1_000_000;
    expect(() => checkRateLimit(now)).not.toThrow();
    expect(() => checkRateLimit(now + 1)).not.toThrow();
    expect(() => checkRateLimit(now + 2)).not.toThrow();
  });

  it('throws ApiError(429) once the window is over the limit', () => {
    const now = 1_000_000;
    checkRateLimit(now);
    checkRateLimit(now + 1);
    checkRateLimit(now + 2);

    let thrown: unknown;
    try {
      checkRateLimit(now + 3);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ApiError);
    const apiErr = thrown as ApiError;
    expect(apiErr.status).toBe(429);
    expect(apiErr.code).toBe('rate_limited');
    expect(errorResponse(apiErr).headers.get('Retry-After')).toBe('1');
  });

  it('recovers after the window rolls past the oldest hits', () => {
    const now = 1_000_000;
    checkRateLimit(now);
    checkRateLimit(now + 100);
    checkRateLimit(now + 200);
    // 4th hit inside the 1000ms window is rejected
    expect(() => checkRateLimit(now + 300)).toThrow(ApiError);

    // Advance past the first hits' windows (a hit at t expires once now-t > 1000):
    // the hits at 0/100/200 are evicted at >1000/1100/1200 respectively.
    expect(() => checkRateLimit(now + 1001)).not.toThrow();
    expect(() => checkRateLimit(now + 1101)).not.toThrow();
    expect(() => checkRateLimit(now + 1201)).not.toThrow();
    // window now holds the three fresh hits → next is rejected again
    expect(() => checkRateLimit(now + 1202)).toThrow(ApiError);
  });

  it('falls back to env defaults (30 per 10s) when env vars are unset', () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', undefined);
    vi.stubEnv('AI_RATE_LIMIT_WINDOW_MS', undefined);
    __resetRateLimitForTests();

    const now = 5_000_000;
    // default max is 30 — 30 calls fit, the 31st is rejected
    for (let i = 0; i < 30; i++) {
      expect(() => checkRateLimit(now + i)).not.toThrow();
    }
    expect(() => checkRateLimit(now + 30)).toThrow(ApiError);

    // a hit past the default 10s window should be allowed again
    __resetRateLimitForTests();
    checkRateLimit(now);
    for (let i = 1; i < 30; i++) checkRateLimit(now + i);
    expect(() => checkRateLimit(now + 30)).toThrow(ApiError);
    expect(() => checkRateLimit(now + 10_001)).not.toThrow();
  });

  it('treats non-positive / non-numeric env config as the default', () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', '0');
    vi.stubEnv('AI_RATE_LIMIT_WINDOW_MS', 'not-a-number');
    __resetRateLimitForTests();

    const now = 9_000_000;
    // max falls back to 30 (not 0), so the first call is allowed
    expect(() => checkRateLimit(now)).not.toThrow();
  });
});

// YUK-594 (W4) — callers that gate BEFORE dispatching need to hand the token back when the
// dispatch fails, or a retry loop over a transient failure drains the window and locks out
// unrelated AI calls (the durable judge enqueue is exactly such a caller).
describe('refundRateLimit', () => {
  beforeEach(() => {
    __resetRateLimitForTests();
    vi.stubEnv('AI_RATE_LIMIT_MAX', '2');
    vi.stubEnv('AI_RATE_LIMIT_WINDOW_MS', '1000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    __resetRateLimitForTests();
  });

  it('returns the token so the slot is reusable', () => {
    const now = 1_000_000;
    const first = checkRateLimit(now);
    checkRateLimit(now + 1);
    // Window is full.
    expect(() => checkRateLimit(now + 2)).toThrow(ApiError);

    refundRateLimit(first);
    expect(() => checkRateLimit(now + 3)).not.toThrow();
  });

  it('refunds only the token it is given, not an arbitrary slot', () => {
    const now = 2_000_000;
    const first = checkRateLimit(now);
    checkRateLimit(now + 1);
    refundRateLimit(first);
    // Exactly one slot came back — the second hit is still holding its own.
    expect(() => checkRateLimit(now + 2)).not.toThrow();
    expect(() => checkRateLimit(now + 3)).toThrow(ApiError);
  });

  it('is a no-op for a token that already aged out of the window', () => {
    const now = 3_000_000;
    const stale = checkRateLimit(now);
    // Roll past the window; the stale hit is evicted by the next check.
    checkRateLimit(now + 2_000);
    expect(() => refundRateLimit(stale)).not.toThrow();
    // The live hit is untouched by the no-op refund.
    checkRateLimit(now + 2_001);
    expect(() => checkRateLimit(now + 2_002)).toThrow(ApiError);
  });
});
