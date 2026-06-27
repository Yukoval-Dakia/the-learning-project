// ADR-0046 — scorePrediction stub unit tests (pure: formula / clamp / n=1).

import { describe, expect, it } from 'vitest';

import { scorePrediction } from './scoring';

describe('scorePrediction (ADR-0046 placeholder stub)', () => {
  it('computes Brier loss for both the model and the baseline', () => {
    const s = scorePrediction(0.3, 0.5, 1);
    expect(s.brierModel).toBeCloseTo((0.3 - 1) ** 2, 10); // 0.49
    expect(s.brierBaseline).toBeCloseTo((0.5 - 1) ** 2, 10); // 0.25
  });

  it('positive skillScorePoint when the model predicts closer to the outcome than baseline', () => {
    expect(scorePrediction(0.9, 0.5, 1).skillScorePoint).toBeGreaterThan(0);
  });

  it('negative skillScorePoint when the model is worse than the baseline', () => {
    expect(scorePrediction(0.1, 0.5, 1).skillScorePoint).toBeLessThan(0);
  });

  it('skillScorePoint is 0 when the baseline is already perfect (nothing to beat)', () => {
    const s = scorePrediction(0.3, 1, 1); // baseline=1, outcome=1 → BS_baseline=0
    expect(s.brierBaseline).toBe(0);
    expect(s.skillScorePoint).toBe(0);
  });

  it('log loss is finite at degenerate predictions p∈{0,1} (ε-clamp, no ±Infinity)', () => {
    expect(Number.isFinite(scorePrediction(0, 0.5, 1).logLossModel)).toBe(true);
    expect(Number.isFinite(scorePrediction(1, 0.5, 0).logLossModel)).toBe(true);
  });

  it('clamps predicted/baseline into [0,1] — out-of-range inputs never NaN (n=1-safe)', () => {
    const s = scorePrediction(1.5, -0.2, 1);
    expect(s.brierModel).toBe(0); // clamped to 1 → (1-1)² = 0
    expect(s.brierBaseline).toBe(1); // clamped to 0 → (0-1)² = 1
    expect(Number.isNaN(s.skillScorePoint)).toBe(false);
  });
});
