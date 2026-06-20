import { describe, expect, it } from 'vitest';

import {
  REFINE_AUTOAPPLY_MAX,
  REFINE_AUTOAPPLY_WARN,
  REFINE_RATE_WINDOW_MS,
  checkAutoApplyBreaker,
} from './note-refine-breaker';

// YUK-358 / ADR-0040 决定1 — pure off-by-one boundaries for the A-track rate
// breaker. The DB-backed countRecentAutoApplies is exercised in
// note-refine.db.test.ts; here we lock the three-tier threshold math.

describe('checkAutoApplyBreaker', () => {
  it('defaults match the module constants (window 1h, warn 8, max 20)', () => {
    expect(REFINE_RATE_WINDOW_MS).toBe(3_600_000);
    expect(REFINE_AUTOAPPLY_WARN).toBe(8);
    expect(REFINE_AUTOAPPLY_MAX).toBe(20);
    // ~3-5× normal ~2-3/h — max sits well above the warn water-mark.
    expect(REFINE_AUTOAPPLY_MAX).toBeGreaterThan(REFINE_AUTOAPPLY_WARN);
  });

  describe('default thresholds (warn=8, max=20)', () => {
    it('count 0 → ok (cold start auto-applies)', () => {
      expect(checkAutoApplyBreaker({ recentCount: 0 })).toEqual({ status: 'ok' });
    });

    it('count warn-1 (7) → still ok', () => {
      expect(checkAutoApplyBreaker({ recentCount: 7 })).toEqual({ status: 'ok' });
    });

    it('count === warn (8) → warned (boundary: warn is inclusive)', () => {
      expect(checkAutoApplyBreaker({ recentCount: 8 })).toEqual({ status: 'warned' });
    });

    it('count between warn and max (12) → warned (still auto-applies)', () => {
      expect(checkAutoApplyBreaker({ recentCount: 12 })).toEqual({ status: 'warned' });
    });

    it('count === max-1 (19) → warned (still under hard cap)', () => {
      expect(checkAutoApplyBreaker({ recentCount: 19 })).toEqual({ status: 'warned' });
    });

    it('count === max (20) → tripped (boundary: max is inclusive)', () => {
      expect(checkAutoApplyBreaker({ recentCount: 20 })).toEqual({ status: 'tripped' });
    });

    it('count > max (50) → tripped (runaway)', () => {
      expect(checkAutoApplyBreaker({ recentCount: 50 })).toEqual({ status: 'tripped' });
    });
  });

  describe('override seam', () => {
    it('honors custom warn/max thresholds', () => {
      expect(checkAutoApplyBreaker({ recentCount: 2, warn: 3, max: 5 })).toEqual({ status: 'ok' });
      expect(checkAutoApplyBreaker({ recentCount: 3, warn: 3, max: 5 })).toEqual({
        status: 'warned',
      });
      expect(checkAutoApplyBreaker({ recentCount: 5, warn: 3, max: 5 })).toEqual({
        status: 'tripped',
      });
    });

    it('warn===max collapses to a single hard boundary (warned tier empty)', () => {
      expect(checkAutoApplyBreaker({ recentCount: 4, warn: 5, max: 5 })).toEqual({ status: 'ok' });
      // at the boundary, tripped wins (max checked before warn).
      expect(checkAutoApplyBreaker({ recentCount: 5, warn: 5, max: 5 })).toEqual({
        status: 'tripped',
      });
    });
  });
});
