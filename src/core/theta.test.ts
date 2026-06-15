import { describe, expect, it } from 'vitest';

import {
  DIFFICULTY_PROXY_WEIGHT,
  conjunctiveCredits,
  difficultyToLogitB,
  eloK,
  expectedScore,
  fisherInformation,
  thetaSe,
  updateTheta,
  updateThetaPrecision,
} from './theta';

describe('expectedScore (1PL ICC)', () => {
  it('returns 0.5 when θ == b', () => {
    expect(expectedScore(0, 0)).toBeCloseTo(0.5, 10);
    expect(expectedScore(1.5, 1.5)).toBeCloseTo(0.5, 10);
  });

  it('rises above 0.5 when θ > b, falls below when θ < b', () => {
    expect(expectedScore(2, 0)).toBeGreaterThan(0.5);
    expect(expectedScore(-2, 0)).toBeLessThan(0.5);
  });

  it('is symmetric around θ == b', () => {
    // P(θ-b=1) + P(θ-b=-1) == 1 (logistic odd symmetry).
    expect(expectedScore(1, 0) + expectedScore(-1, 0)).toBeCloseTo(1, 10);
  });
});

describe('updateTheta', () => {
  it('raises θ̂ on a correct answer (outcome=1)', () => {
    const next = updateTheta(0, 0, 1, 0.4);
    expect(next).toBeGreaterThan(0);
    // expected=0.5, so Δ = k*(1-0.5) = 0.2.
    expect(next).toBeCloseTo(0.2, 10);
  });

  it('lowers θ̂ on a wrong answer (outcome=0)', () => {
    const next = updateTheta(0, 0, 0, 0.4);
    expect(next).toBeLessThan(0);
    // Δ = k*(0-0.5) = -0.2.
    expect(next).toBeCloseTo(-0.2, 10);
  });

  it('produces a tiny Δ when θ ≫ b and the answer is correct (saturation)', () => {
    // expected ≈ 1 when θ-b is large, so a correct answer barely moves θ̂.
    const next = updateTheta(5, 0, 1, 0.4);
    expect(next - 5).toBeGreaterThan(0);
    expect(next - 5).toBeLessThan(0.01);
  });

  it('applies weight as a linear scale on the step', () => {
    const full = updateTheta(0, 0, 1, 0.4, 1);
    const weighted = updateTheta(0, 0, 1, 0.4, DIFFICULTY_PROXY_WEIGHT);
    expect(weighted).toBeCloseTo(full * DIFFICULTY_PROXY_WEIGHT, 10);
  });

  it('default weight is 1', () => {
    expect(updateTheta(0, 0, 1, 0.4)).toBeCloseTo(updateTheta(0, 0, 1, 0.4, 1), 10);
  });
});

describe('eloK (bounded K + cold-start, NO 1/√n)', () => {
  it('returns kCold during the cold-start segment (evidence < coldStartN)', () => {
    expect(eloK(0)).toBe(0.4);
    expect(eloK(3)).toBe(0.4);
  });

  it('returns kFloor once past the cold-start segment (evidence >= coldStartN)', () => {
    expect(eloK(4)).toBe(0.12);
    expect(eloK(100)).toBe(0.12);
  });

  it('NEVER returns 0 — non-stationary protection (refutes 1/√n decay-to-zero)', () => {
    // Regression guard: VERIFY:elo-k-schedule REFUTED the 1/√(evidence) schedule.
    // K must stay bounded below so θ̂ keeps the freedom to chase rising ability.
    for (const n of [0, 1, 4, 10, 50, 1000, 100_000]) {
      expect(eloK(n)).toBeGreaterThan(0);
    }
  });

  it('honors config overrides', () => {
    expect(eloK(0, { kCold: 0.6 })).toBe(0.6);
    expect(eloK(10, { kFloor: 0.05 })).toBe(0.05);
    expect(eloK(2, { coldStartN: 1, kFloor: 0.1 })).toBe(0.1);
  });
});

describe('difficultyToLogitB (placeholder proxy map)', () => {
  it('maps difficulty=3 to logit 0 (origin)', () => {
    expect(difficultyToLogitB(3)).toBeCloseTo(0, 10);
  });

  it('is symmetric: difficulty 1 and 5 are ±2*scale around 0', () => {
    const d1 = difficultyToLogitB(1);
    const d5 = difficultyToLogitB(5);
    expect(d1).toBeCloseTo(-d5, 10);
    expect(d5).toBeCloseTo(2 * 0.85, 10);
  });

  it('honors a custom scale', () => {
    expect(difficultyToLogitB(4, 1)).toBeCloseTo(1, 10);
  });
});

describe('DIFFICULTY_PROXY_WEIGHT', () => {
  it('is a sub-1 down-weight for the weak difficulty proxy anchor', () => {
    expect(DIFFICULTY_PROXY_WEIGHT).toBeGreaterThan(0);
    expect(DIFFICULTY_PROXY_WEIGHT).toBeLessThan(1);
    expect(DIFFICULTY_PROXY_WEIGHT).toBeCloseTo(0.3, 10);
  });
});

describe('conjunctiveCredits (multi-KC MLE, owner-ratified / SF-1 fix)', () => {
  it('single KC reduces EXACTLY to standard Elo residual (outcome − p)', () => {
    // correct + wrong both must equal (x − σ(θ−b)) so the n=1 path is unchanged.
    const [cCorrect] = conjunctiveCredits([0.5], 0, 1);
    const [cWrong] = conjunctiveCredits([0.5], 0, 0);
    expect(cCorrect).toBeCloseTo(1 - expectedScore(0.5, 0), 12);
    expect(cWrong).toBeCloseTo(0 - expectedScore(0.5, 0), 12);
    // And applying it must match updateTheta's single-KC result.
    const k = 0.12;
    expect(0.5 + k * cWrong).toBeCloseTo(updateTheta(0.5, 0, 0, k), 12);
  });

  it('empty input returns empty (no KCs → no-op)', () => {
    expect(conjunctiveCredits([], 0, 1)).toEqual([]);
  });

  it('correct: every KC gets a positive bump, weaker KC bumped MORE ((1−p_k))', () => {
    // A strong θ=2 (p≈0.88), B weak θ=-1 (p≈0.27), b=0.
    const [cA, cB] = conjunctiveCredits([2, -1], 0, 1);
    expect(cA).toBeGreaterThan(0);
    expect(cB).toBeGreaterThan(0);
    expect(cB).toBeGreaterThan(cA); // weaker KC has larger (1−p) sensitivity
  });

  it('SF-1 regression: wrong answer blames the WEAKER KC more, not the mid one', () => {
    // The old self-authored formula had Δ ∝ p_k·(1−p_k) (bell-shaped) → an
    // already-weak KC (p→0) barely moved. MLE conjunctive credit must blame the
    // weaker KC MORE. mid θ=0 (p=0.5) vs very-weak θ=-3 (p≈0.047), b=0, wrong.
    const [cMid, cWeak] = conjunctiveCredits([0, -3], 0, 0);
    expect(cMid).toBeLessThan(0); // both fall
    expect(cWeak).toBeLessThan(0);
    // weaker KC falls MORE (more negative) — the exact direction the bug inverted.
    expect(cWeak).toBeLessThan(cMid);
  });

  it('wrong: mastered KC is spared relative to a neutral KC', () => {
    // A mastered θ=2, B neutral θ=0, b=0, wrong. B (weaker) should fall more.
    const [cA, cB] = conjunctiveCredits([2, 0], 0, 0);
    expect(Math.abs(cB)).toBeGreaterThan(Math.abs(cA));
  });

  it('clamps each credit magnitude to ≤ 1 (all-strong KCs, big surprise)', () => {
    // Two strong KCs both wrong → P_item small denominator, odds large; clamp.
    const credits = conjunctiveCredits([4, 4], 0, 0);
    for (const c of credits) {
      expect(c).toBeGreaterThanOrEqual(-1);
      expect(c).toBeLessThanOrEqual(0);
    }
  });
});

describe('fisherInformation (Rasch single-observation θ info I = p(1−p))', () => {
  it('is maximal (0.25) when θ == b (p = 0.5)', () => {
    expect(fisherInformation(0, 0)).toBeCloseTo(0.25, 10);
  });

  it('decays toward 0 as θ moves far from b (saturated item gives little info)', () => {
    expect(fisherInformation(4, 0)).toBeLessThan(0.02);
  });

  it('is symmetric in |θ − b| (logistic odd symmetry)', () => {
    expect(fisherInformation(2, 0)).toBeCloseTo(fisherInformation(-2, 0), 12);
  });
});

describe('thetaSe (SE = 1/√precision, derived not stored)', () => {
  it('precision=4 → SE=0.5', () => {
    expect(thetaSe(4)).toBeCloseTo(0.5, 10);
  });

  it('precision=1 → SE=1 (backfill-safe default)', () => {
    expect(thetaSe(1)).toBeCloseTo(1, 10);
  });

  it('higher precision → smaller SE (monotone)', () => {
    expect(thetaSe(9)).toBeLessThan(thetaSe(4));
  });

  it('floors precision at 1e-9 to avoid division by zero', () => {
    expect(Number.isFinite(thetaSe(0))).toBe(true);
  });
});

describe('updateThetaPrecision (accumulate Σ I, weight² scaling)', () => {
  it('adds full Fisher info at unit weight: 1 + 0.25 = 1.25', () => {
    expect(updateThetaPrecision(1, 0, 0, 1)).toBeCloseTo(1.25, 10);
  });

  it('scales info by weight² (proxy bWeight=0.3 → only 0.09·0.25 added)', () => {
    expect(updateThetaPrecision(1, 0, 0, 0.3)).toBeCloseTo(1 + 0.09 * 0.25, 10);
  });

  it('default weight is 1', () => {
    expect(updateThetaPrecision(1, 0, 0)).toBeCloseTo(updateThetaPrecision(1, 0, 0, 1), 10);
  });

  it('a saturated item (θ ≫ b) adds almost no precision', () => {
    const before = 2;
    expect(updateThetaPrecision(before, 4, 0, 1) - before).toBeLessThan(0.02);
  });
});
