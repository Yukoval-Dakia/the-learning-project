// B1 four-engine soft-track inc-1 (YUK-348) — BKT forward estimator unit tests.
//
// Pure function, no DB → unit config. Covers: result shape; pLFinal rises on
// consecutive-correct / falls on consecutive-wrong; and the RED LINE prior-echo
// invariant — EMPTY / very-short sequences return the prior VERBATIM ("never
// fabricates info at n=1", ADR-0035 决定 #4 / Stocking 1990).

import { describe, expect, it } from 'vitest';

import {
  type BktPrior,
  DEFAULT_BKT_PRIOR,
  DEFAULT_P_G,
  DEFAULT_P_L0,
  DEFAULT_P_S,
  DEFAULT_P_T,
  estimateBkt,
} from './kt-estimator';

describe('estimateBkt — shape', () => {
  it('returns the full BktEstimate shape with the prior echoed in the param fields', () => {
    const e = estimateBkt([1, 0, 1]);
    // Param fields are the (fixed) prior, echoed verbatim — pT/pS/pG are NOT fit
    // from data (n=1 structurally non-estimable, ADR-0035 决定 #4).
    expect(e.pL0).toBeCloseTo(DEFAULT_P_L0, 12);
    expect(e.pT).toBeCloseTo(DEFAULT_P_T, 12);
    expect(e.pS).toBeCloseTo(DEFAULT_P_S, 12);
    expect(e.pG).toBeCloseTo(DEFAULT_P_G, 12);
    expect(e.n).toBe(3);
    // pLFinal is a probability the forward recursion produced.
    expect(e.pLFinal).toBeGreaterThanOrEqual(0);
    expect(e.pLFinal).toBeLessThanOrEqual(1);
    expect(Number.isFinite(e.pLFinal)).toBe(true);
  });
});

describe('estimateBkt — monotone direction of pLFinal', () => {
  it('rises on a consecutive-correct run', () => {
    const a = estimateBkt([1]);
    const b = estimateBkt([1, 1]);
    const c = estimateBkt([1, 1, 1, 1, 1, 1]);
    // Each additional correct answer pushes the mastery posterior up (vs the
    // prior p(L0)) and the run is monotone non-decreasing.
    expect(a.pLFinal).toBeGreaterThan(DEFAULT_P_L0);
    expect(b.pLFinal).toBeGreaterThan(a.pLFinal);
    expect(c.pLFinal).toBeGreaterThan(b.pLFinal);
    // A long correct run approaches (near) certainty of mastery.
    expect(c.pLFinal).toBeGreaterThan(0.95);
  });

  it('falls on a consecutive-wrong run', () => {
    const a = estimateBkt([0]);
    const b = estimateBkt([0, 0]);
    const c = estimateBkt([0, 0, 0, 0, 0, 0]);
    // Each additional wrong answer pushes the mastery posterior down (vs the
    // prior). It is monotone non-increasing across the wrong run.
    expect(a.pLFinal).toBeLessThan(DEFAULT_P_L0);
    expect(b.pLFinal).toBeLessThan(a.pLFinal);
    expect(c.pLFinal).toBeLessThan(b.pLFinal);
  });

  it('a correct run ends higher than a wrong run of the same length', () => {
    const correct = estimateBkt([1, 1, 1, 1]);
    const wrong = estimateBkt([0, 0, 0, 0]);
    expect(correct.pLFinal).toBeGreaterThan(wrong.pLFinal);
  });
});

describe('estimateBkt — RED LINE prior-echo (never fabricates info at n=1)', () => {
  it('returns the prior VERBATIM on an EMPTY sequence', () => {
    const e = estimateBkt([]);
    // No observations → zero information increment → pLFinal MUST equal p(L0),
    // and every param field is the prior, untouched. This is the prior-echo
    // red line: the soft track never fabricates info at n=0.
    expect(e.n).toBe(0);
    expect(e.pLFinal).toBe(DEFAULT_P_L0); // exact, not toBeCloseTo — verbatim.
    expect(e.pL0).toBe(DEFAULT_P_L0);
    expect(e.pT).toBe(DEFAULT_P_T);
    expect(e.pS).toBe(DEFAULT_P_S);
    expect(e.pG).toBe(DEFAULT_P_G);
  });

  it('echoes a CUSTOM prior verbatim on an empty sequence', () => {
    const prior: BktPrior = { pL0: 0.42, pT: 0.07, pS: 0.13, pG: 0.31 };
    const e = estimateBkt([], prior);
    expect(e.pLFinal).toBe(0.42); // verbatim p(L0) — no fabrication.
    expect(e.pL0).toBe(0.42);
    expect(e.pT).toBe(0.07);
    expect(e.pS).toBe(0.13);
    expect(e.pG).toBe(0.31);
    expect(e.n).toBe(0);
  });

  it('a very-short (n=1) sequence still echoes all four prior params unchanged', () => {
    // The four params are the prior regardless of sequence length — only pLFinal
    // moves. At n=1 pLFinal is a single-step update, NOT a fit of pT/pS/pG.
    const e = estimateBkt([1], DEFAULT_BKT_PRIOR);
    expect(e.n).toBe(1);
    expect(e.pL0).toBe(DEFAULT_P_L0);
    expect(e.pT).toBe(DEFAULT_P_T);
    expect(e.pS).toBe(DEFAULT_P_S);
    expect(e.pG).toBe(DEFAULT_P_G);
  });

  it('clamps an out-of-range prior into [0,1] (robustness, still no fabrication)', () => {
    const e = estimateBkt([], { pL0: 1.5, pT: -0.2, pS: 2, pG: -1 });
    expect(e.pL0).toBe(1);
    expect(e.pT).toBe(0);
    expect(e.pS).toBe(1);
    expect(e.pG).toBe(0);
    expect(e.pLFinal).toBe(1); // echoes the clamped p(L0).
  });
});
