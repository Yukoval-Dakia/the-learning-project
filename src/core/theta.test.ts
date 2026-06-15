import { describe, expect, it } from 'vitest';

import {
  DIFFICULTY_PROXY_WEIGHT,
  difficultyToLogitB,
  eloK,
  expectedScore,
  updateTheta,
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
