import { describe, expect, it } from 'vitest';

import {
  VERDICT_AUTOAPPLY_MAX,
  VERDICT_AUTOAPPLY_WARN,
  VERDICT_RATE_WINDOW_MS,
  checkAutoApplyBreaker,
  checkVerdictRateBreaker,
} from './decide-breaker';

// YUK-521 (A4 强度轴 / ADR-0039 A 档) — pure off-by-one boundaries for the verdict
// rate breaker (mirrors note-refine-breaker.unit.test.ts). The DB-backed
// countRecentVerdicts is exercised via the auto-apply DB tests; here we lock the
// three-tier threshold math + the composite's dep-injected packing.

describe('checkVerdictRateBreaker', () => {
  it('defaults match the module constants (window 1h, warn 12, max 30)', () => {
    expect(VERDICT_RATE_WINDOW_MS).toBe(3_600_000);
    expect(VERDICT_AUTOAPPLY_WARN).toBe(12);
    expect(VERDICT_AUTOAPPLY_MAX).toBe(30);
    // ~3-5× normal verdict rate — max sits well above the warn water-mark.
    expect(VERDICT_AUTOAPPLY_MAX).toBeGreaterThan(VERDICT_AUTOAPPLY_WARN);
  });

  describe('default thresholds (warn=12, max=30)', () => {
    it('count 0 → ok', () => {
      expect(checkVerdictRateBreaker({ recentCount: 0 })).toEqual({ status: 'ok' });
    });

    it('count warn-1 (11) → still ok', () => {
      expect(checkVerdictRateBreaker({ recentCount: 11 })).toEqual({ status: 'ok' });
    });

    it('count === warn (12) → warned (boundary: warn inclusive)', () => {
      expect(checkVerdictRateBreaker({ recentCount: 12 })).toEqual({ status: 'warned' });
    });

    it('count === max-1 (29) → warned (still under hard cap)', () => {
      expect(checkVerdictRateBreaker({ recentCount: 29 })).toEqual({ status: 'warned' });
    });

    it('count === max (30) → tripped (boundary: max inclusive)', () => {
      expect(checkVerdictRateBreaker({ recentCount: 30 })).toEqual({ status: 'tripped' });
    });

    it('count > max (90) → tripped (runaway)', () => {
      expect(checkVerdictRateBreaker({ recentCount: 90 })).toEqual({ status: 'tripped' });
    });
  });

  describe('override seam', () => {
    it('honors custom warn/max thresholds', () => {
      expect(checkVerdictRateBreaker({ recentCount: 2, warn: 3, max: 5 })).toEqual({
        status: 'ok',
      });
      expect(checkVerdictRateBreaker({ recentCount: 3, warn: 3, max: 5 })).toEqual({
        status: 'warned',
      });
      expect(checkVerdictRateBreaker({ recentCount: 5, warn: 3, max: 5 })).toEqual({
        status: 'tripped',
      });
    });

    it('warn===max collapses to a single hard boundary (max checked first)', () => {
      expect(checkVerdictRateBreaker({ recentCount: 4, warn: 5, max: 5 })).toEqual({
        status: 'ok',
      });
      expect(checkVerdictRateBreaker({ recentCount: 5, warn: 5, max: 5 })).toEqual({
        status: 'tripped',
      });
    });
  });
});

describe('checkAutoApplyBreaker (composite, dep-injected)', () => {
  // A throwing proxy proves the dep-injected path never touches the db arg.
  const noDb = new Proxy(
    {},
    {
      get() {
        throw new Error('db should not be touched when countRecentVerdicts is injected');
      },
    },
  ) as never;

  it('packs an ok snapshot with cap + window for the UI meter', async () => {
    const result = await checkAutoApplyBreaker(noDb, new Date(), {
      countRecentVerdicts: async () => 3,
    });
    expect(result).toEqual({
      tripped: false,
      level: 'ok',
      applied: 3,
      cap: VERDICT_AUTOAPPLY_MAX,
      window: VERDICT_RATE_WINDOW_MS,
    });
  });

  it('flags tripped at the hard cap', async () => {
    const result = await checkAutoApplyBreaker(noDb, new Date(), {
      countRecentVerdicts: async () => VERDICT_AUTOAPPLY_MAX,
    });
    expect(result.tripped).toBe(true);
    expect(result.level).toBe('tripped');
    expect(result.applied).toBe(VERDICT_AUTOAPPLY_MAX);
  });

  it('warned tier still reports not tripped', async () => {
    const result = await checkAutoApplyBreaker(noDb, new Date(), {
      countRecentVerdicts: async () => VERDICT_AUTOAPPLY_WARN,
    });
    expect(result.tripped).toBe(false);
    expect(result.level).toBe('warned');
  });
});
