// TASK 3 — ICC(1,1) one-way random-effects ANOVA estimator + design-effect + effective-N.
// Sources: Shrout & Fleiss, Psych Bull 1979 (ICC(1,1)); Kish, Survey Sampling 1965 (deff).
// Known-answer tests HAND-COMPUTED. effectiveNFromClusters must NEVER return NaN (m4).

import { describe, expect, it } from 'vitest';
import { designEffect, effectiveNFromClusters, iccOneWayAnova } from './design-effect';

describe('iccOneWayAnova — ICC(1,1)', () => {
  it('anchor: ICC = 0.5 (clusters [[1,1,0],[0,0,0]], hand-computed)', () => {
    // k=2, N=6, ȳ=1/3, ȳ1=2/3, ȳ2=0.
    // MSB = [3*(1/3)^2 + 3*(1/3)^2]/1 = 2/3 ≈ 0.6667
    // MSW = (2/3)/4 = 1/6 ≈ 0.1667
    // m0  = (6 - 18/6)/1 = 3
    // ICC = (2/3 - 1/6)/(2/3 + 2*1/6) = (1/2)/1 = 0.5
    const r = iccOneWayAnova([
      [1, 1, 0],
      [0, 0, 0],
    ]);
    expect(r.icc).toBeCloseTo(0.5, 10);
    expect(r.m0).toBeCloseTo(3, 10);
    expect(r.k).toBe(2);
    expect(r.n).toBe(6);
  });

  it('ρ→0 clamps to 0: clusters [[1,0],[1,0],[1,0]] → icc 0', () => {
    const r = iccOneWayAnova([
      [1, 0],
      [1, 0],
      [1, 0],
    ]);
    expect(r.icc).toBeCloseTo(0, 10);
  });

  it('ρ=1: clusters [[1,1,1],[0,0,0]] → icc 1.0 (MSW=0)', () => {
    const r = iccOneWayAnova([
      [1, 1, 1],
      [0, 0, 0],
    ]);
    expect(r.icc).toBeCloseTo(1.0, 10);
  });

  it('all-singleton → icc null, reason all-singleton', () => {
    const r = iccOneWayAnova([[1], [0], [1]]);
    expect(r.icc).toBeNull();
    expect(r.reason).toBe('all-singleton');
  });

  it('single cluster → icc null, reason single-cluster', () => {
    const r = iccOneWayAnova([[1, 0, 1]]);
    expect(r.icc).toBeNull();
    expect(r.reason).toBe('single-cluster');
  });

  it('zero total variance → icc 0, reason zero-variance', () => {
    const r = iccOneWayAnova([
      [1, 1],
      [1, 1],
    ]);
    expect(r.icc).toBe(0);
    expect(r.reason).toBe('zero-variance');
  });

  it('empty → icc null, reason empty', () => {
    const r = iccOneWayAnova([]);
    expect(r.icc).toBeNull();
    expect(r.reason).toBe('empty');
  });

  // ── OCR finding 5: empty sub-arrays must NOT inflate k (would make N−k negative). ──
  it('OCR finding 5: empty sub-arrays are dropped, not counted in k', () => {
    // Before the fix: raw k=3, N=2 → N−k = −1 → MSW = ssWithin/(−1) → silently wrong ICC.
    // After: empties dropped → one real cluster [[1,0]] → single-cluster null (not garbage).
    const r = iccOneWayAnova([[1, 0], [], []]);
    expect(r.icc).toBeNull();
    expect(r.reason).toBe('single-cluster');
    expect(r.k).toBe(1);
    expect(r.n).toBe(2);
  });

  it('OCR finding 5: empties interspersed with real clusters match the no-empty result', () => {
    // [[1,1,0],[],[0,0,0]] must give the SAME ICC as the anchor [[1,1,0],[0,0,0]] (0.5),
    // not a negative-denominator artefact from N−k inflation.
    const r = iccOneWayAnova([[1, 1, 0], [], [0, 0, 0]]);
    expect(r.icc).toBeCloseTo(0.5, 10);
    expect(r.k).toBe(2);
    expect(r.n).toBe(6);
    expect(r.m0).toBeCloseTo(3, 10);
  });

  it('OCR finding 5: all-empty clusters → empty (not a crash)', () => {
    const r = iccOneWayAnova([[], [], []]);
    expect(r.icc).toBeNull();
    expect(r.reason).toBe('empty');
  });
});

describe('designEffect', () => {
  it('deff = 1 + (m-1)*icc', () => {
    expect(designEffect(3, 0.5)).toBeCloseTo(2.0, 12);
  });
  it('m=1 → deff = 1 regardless of icc', () => {
    expect(designEffect(1, 0.9)).toBeCloseTo(1.0, 12);
  });
});

describe('effectiveNFromClusters — never NaN (m4)', () => {
  it('anchor: deff=2, effectiveN=3 for [[1,1,0],[0,0,0]]', () => {
    const r = effectiveNFromClusters([
      [1, 1, 0],
      [0, 0, 0],
    ]);
    expect(r.deff).toBeCloseTo(2.0, 10);
    expect(r.effectiveN).toBeCloseTo(3.0, 10);
    expect(r.icc).toBeCloseTo(0.5, 10);
  });

  it('ρ=1 → deff=3, effectiveN=2', () => {
    const r = effectiveNFromClusters([
      [1, 1, 1],
      [0, 0, 0],
    ]);
    expect(r.deff).toBeCloseTo(3.0, 10);
    expect(r.effectiveN).toBeCloseTo(2.0, 10);
  });

  it('all-singleton → deff=1, effectiveN=N (3), NOT NaN', () => {
    const r = effectiveNFromClusters([[1], [0], [1]]);
    expect(r.deff).toBe(1);
    expect(r.effectiveN).toBe(3);
    expect(Number.isNaN(r.effectiveN)).toBe(false);
  });

  it('single cluster → deff=1, effectiveN=N (3)', () => {
    const r = effectiveNFromClusters([[1, 0, 1]]);
    expect(r.deff).toBe(1);
    expect(r.effectiveN).toBe(3);
  });

  it('zero variance → deff=1, effectiveN=N (4)', () => {
    const r = effectiveNFromClusters([
      [1, 1],
      [1, 1],
    ]);
    expect(r.deff).toBe(1);
    expect(r.effectiveN).toBe(4);
  });

  it('empty → deff=1, effectiveN=0', () => {
    const r = effectiveNFromClusters([]);
    expect(r.deff).toBe(1);
    expect(r.effectiveN).toBe(0);
    expect(Number.isNaN(r.effectiveN)).toBe(false);
  });

  it('OCR finding 5: empty sub-arrays never yield NaN effectiveN', () => {
    const r = effectiveNFromClusters([[1, 1, 0], [], [0, 0, 0]]);
    expect(Number.isNaN(r.effectiveN)).toBe(false);
    expect(r.deff).toBeCloseTo(2.0, 10); // same as the no-empty anchor
    expect(r.effectiveN).toBeCloseTo(3.0, 10);
  });
});
