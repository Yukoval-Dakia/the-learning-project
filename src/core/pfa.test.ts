// B1 (ADR-0035 决定#2) — PFA p(L) 难度感知投影纯函数单测。

import { describe, expect, it } from 'vitest';

import {
  LOW_CONFIDENCE_SE_THRESHOLD,
  PFA_GAMMA,
  PFA_RHO,
  pLearned,
  pLearnedBand,
  pfaLogit,
} from './pfa';

describe('pfaLogit (ADR-0035 sign convention: logit = γ·success + ρ·fail − β)', () => {
  it('cold start (β=0, success=0, fail=0) → logit 0', () => {
    expect(pfaLogit(0, PFA_GAMMA, PFA_RHO, 0, 0)).toBe(0);
  });

  it('β enters with a negative sign (harder item lowers logit)', () => {
    // Same counts, β=1 vs β=0 → the β=1 logit is exactly 1 lower.
    const easy = pfaLogit(0, PFA_GAMMA, PFA_RHO, 2, 1);
    const hard = pfaLogit(1, PFA_GAMMA, PFA_RHO, 2, 1);
    expect(hard).toBeCloseTo(easy - 1, 10);
  });

  it('matches γ·success + ρ·fail − β exactly', () => {
    expect(pfaLogit(0.5, 0.4, -0.2, 3, 2)).toBeCloseTo(0.4 * 3 + -0.2 * 2 - 0.5, 10);
  });
});

describe('pLearned (p(L) = σ(pfaLogit))', () => {
  it('cold start β=0, success=0, fail=0 → p(L) = 0.5', () => {
    expect(pLearned(0, PFA_GAMMA, PFA_RHO, 0, 0)).toBeCloseTo(0.5, 10);
  });

  it('monotone in success: more successes raises p(L) (fixed fail, β)', () => {
    const before = pLearned(0, PFA_GAMMA, PFA_RHO, 2, 1);
    const after = pLearned(0, PFA_GAMMA, PFA_RHO, 3, 1);
    expect(after).toBeGreaterThan(before);
  });

  it('monotone in fail: more failures lowers p(L) (fixed success, β)', () => {
    const before = pLearned(0, PFA_GAMMA, PFA_RHO, 2, 1);
    const after = pLearned(0, PFA_GAMMA, PFA_RHO, 2, 2);
    expect(after).toBeLessThan(before);
  });

  it('harder item (β up) lowers p(L) at fixed success/fail counts', () => {
    const easy = pLearned(0, PFA_GAMMA, PFA_RHO, 3, 1);
    const hard = pLearned(1.5, PFA_GAMMA, PFA_RHO, 3, 1);
    expect(hard).toBeLessThan(easy);
  });

  it('always strictly in (0, 1) for realistic counts', () => {
    // σ asymptotes to 1/0 but never reaches them; with extreme logits float
    // saturates to exactly 1.0/0.0, so we assert on realistic-magnitude counts.
    const high = pLearned(0, PFA_GAMMA, PFA_RHO, 20, 0);
    const low = pLearned(0, PFA_GAMMA, PFA_RHO, 0, 20);
    expect(high).toBeLessThan(1);
    expect(high).toBeGreaterThan(0.5);
    expect(low).toBeGreaterThan(0);
    expect(low).toBeLessThan(0.5);
  });

  it('default coefficients have the expected signs (γ>0, ρ<0)', () => {
    expect(PFA_GAMMA).toBeGreaterThan(0);
    expect(PFA_RHO).toBeLessThan(0);
  });

  it('β≈3 hard prereq needs 8 clean corrects to cross 0.7 (YUK-539 defect-c regression)', () => {
    // Candidate B (γ=0.5): K(β=3) = ceil((0.8473+3)/0.5) = 8. Pins the retune target that
    // eased hard-prereq starvation from 10 (γ=0.4) → 8 clean corrects. Uses the 0.7
    // MASTERED_PL_THRESHOLD literal (core/ must not import from capabilities/).
    expect(pLearned(3, PFA_GAMMA, PFA_RHO, 7, 0)).toBeLessThan(0.7);
    expect(pLearned(3, PFA_GAMMA, PFA_RHO, 8, 0)).toBeGreaterThanOrEqual(0.7);
  });
});

describe('pLearnedBand (CI band + low-confidence flag)', () => {
  it('point equals σ(pointLogit); lo < point < hi for positive SE', () => {
    const band = pLearnedBand(0.5, 0.5);
    expect(band.point).toBeCloseTo(1 / (1 + Math.exp(-0.5)), 10);
    expect(band.lo).toBeLessThan(band.point);
    expect(band.hi).toBeGreaterThan(band.point);
  });

  it('band widens as theta_se grows', () => {
    const tight = pLearnedBand(0, 0.3);
    const wide = pLearnedBand(0, 0.9);
    const tightWidth = tight.hi - tight.lo;
    const wideWidth = wide.hi - wide.lo;
    expect(wideWidth).toBeGreaterThan(tightWidth);
  });

  it('SE=0 collapses the band to the point (lo = point = hi)', () => {
    const band = pLearnedBand(0.7, 0);
    expect(band.lo).toBeCloseTo(band.point, 10);
    expect(band.hi).toBeCloseTo(band.point, 10);
    expect(band.lowConfidence).toBe(false);
  });

  it('lowConfidence flips at the precision threshold', () => {
    // Just below the threshold → confident; at/above → low confidence.
    const below = pLearnedBand(0, LOW_CONFIDENCE_SE_THRESHOLD - 0.01);
    const atOrAbove = pLearnedBand(0, LOW_CONFIDENCE_SE_THRESHOLD);
    const above = pLearnedBand(0, LOW_CONFIDENCE_SE_THRESHOLD + 0.5);
    expect(below.lowConfidence).toBe(false);
    expect(atOrAbove.lowConfidence).toBe(true);
    expect(above.lowConfidence).toBe(true);
  });
});
