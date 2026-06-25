// YUK-495 Phase 1 (#125 rider) — one-KC cold-start solver shape + accuracy.
// JS↔Rust BIT-parity is asserted separately (coldstart-solver-parity.unit.test.ts);
// here: cold-start neutrality, monotonicity, SE narrowing, and closeness to the LIVE
// Math.exp grid fold (the poly σ moves θ̂ negligibly).

import { describe, expect, it } from 'vitest';
import { solveThetaOneKc } from './coldstart-solver';
import {
  GRID_POINTS,
  GRID_THETA,
  binaryLikelihood,
  gridUpdate,
  posteriorMean,
  posteriorSe,
  uniformPrior,
} from './theta-grid';

// Reference: the LIVE grid fold (Math.exp via binaryLikelihood) for closeness comparison.
function liveSolve(bPrime: number, answers: ReadonlyArray<0 | 1>) {
  let post = uniformPrior();
  for (const o of answers) post = gridUpdate(post, bPrime, o);
  return { thetaHat: posteriorMean(post), se: posteriorSe(post) };
}

describe('coldstart-solver — one-KC grid θ̂ on shared poly σ (YUK-495 #125 rider)', () => {
  it('cold start (no answers) → θ̂ = 0 (symmetric uniform prior), SE > 0', () => {
    const s = solveThetaOneKc(0, []);
    expect(Math.abs(s.thetaHat)).toBeLessThan(1e-12); // grid is symmetric about 0
    expect(s.se).toBeGreaterThan(2); // uniform over [-4,4] → wide
    expect(s.evidence).toBe(0);
  });

  it('monotone: more correct ⇒ higher θ̂; more wrong ⇒ lower', () => {
    const allRight = solveThetaOneKc(0, [1, 1, 1, 1, 1, 1]);
    const mixed = solveThetaOneKc(0, [1, 0, 1, 0]);
    const allWrong = solveThetaOneKc(0, [0, 0, 0, 0, 0, 0]);
    expect(allRight.thetaHat).toBeGreaterThan(mixed.thetaHat);
    expect(mixed.thetaHat).toBeGreaterThan(allWrong.thetaHat);
    expect(allRight.thetaHat).toBeGreaterThan(0);
    expect(allWrong.thetaHat).toBeLessThan(0);
  });

  it('SE narrows as evidence accrues', () => {
    const few = solveThetaOneKc(0, [1, 0]);
    const many = solveThetaOneKc(0, [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(many.se).toBeLessThan(few.se);
  });

  it('difficulty anchor: getting HARDER items right ⇒ HIGHER inferred θ̂ (IRT inversion)', () => {
    // p(correct) = σ(offset − b'); to explain the same all-correct answers, a higher b'
    // forces the posterior offset higher. (This is the inverse of "harder ⇒ lower p(L)
    // at FIXED ability" — here ability is INFERRED from the answers.)
    const easy = solveThetaOneKc(-1.5, [1, 1, 1, 1]);
    const hard = solveThetaOneKc(1.5, [1, 1, 1, 1]);
    expect(hard.thetaHat).toBeGreaterThan(easy.thetaHat);
  });

  it('close to the LIVE Math.exp grid fold (poly σ moves θ̂ negligibly)', () => {
    for (const bPrime of [-2, -0.5, 0, 0.7, 2]) {
      for (const answers of [
        [1, 1, 1] as (0 | 1)[],
        [0, 1, 0, 1] as (0 | 1)[],
        [1, 1, 1, 1, 1, 0, 1, 0] as (0 | 1)[],
      ]) {
        const poly = solveThetaOneKc(bPrime, answers);
        const live = liveSolve(bPrime, answers);
        expect(Math.abs(poly.thetaHat - live.thetaHat)).toBeLessThan(1e-9);
        expect(Math.abs(poly.se - live.se)).toBeLessThan(1e-9);
      }
    }
  });

  it('grid support sanity (matches theta-grid.ts construction)', () => {
    // guards the -4 + i·step rebuild against the imported GRID_THETA.
    expect(GRID_POINTS).toBe(41);
    expect(GRID_THETA[0]).toBe(-4);
    expect(GRID_THETA[GRID_POINTS - 1]).toBe(4);
    // a degenerate-likelihood probe: extreme anchor + answer never NaNs θ̂.
    const s = solveThetaOneKc(
      0,
      Array.from({ length: 50 }, () => 1 as 0 | 1),
    );
    expect(Number.isFinite(s.thetaHat)).toBe(true);
    expect(Number.isFinite(s.se)).toBe(true);
    // binaryLikelihood import touched so the live reference path is covered.
    expect(binaryLikelihood(0, 0, 1)).toBeCloseTo(0.5, 12);
  });
});
