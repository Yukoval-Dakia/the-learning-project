// YUK-495 — one-KC cold-start θ̂ solver on the shared polynomial σ.
//
// The full multi-KC coupled MAP/EM is Phase 3; for one KC there is no latent coupling,
// so it collapses to sequential-Bayes grid folding. This is the determinism-critical
// core the coupled sweep later builds on. Contract, ported verbatim to Rust:
//   - frozen 41-point grid on [-4,4], built as -4 + i·step (never a literal table);
//   - shared polySigmoid, not Math.exp, so Object.is parity holds;
//   - answers folded by index; grid mass summed left-to-right with no FMA/reorder;
//   - underflow keeps the prior shape but still counts the answer;
//   - mean/SE accumulate in index order.
//
// b is a locked input anchor (b' = b − θ_global); only this learner's θ̂ offset is fit.

import { polySigmoid } from './poly-exp';
import { GRID_MAX, GRID_MIN, GRID_POINTS } from './theta-grid';

// Rebuilt from the same constants so theta-grid and the Rust port share one construction.
const GRID_STEP = (GRID_MAX - GRID_MIN) / (GRID_POINTS - 1);
const GRID_THETA: readonly number[] = Array.from(
  { length: GRID_POINTS },
  (_, i) => GRID_MIN + i * GRID_STEP,
);

export interface OneKcSolution {
  /** Posterior-mean offset θ̂ over the grid. */
  thetaHat: number;
  /** Calibrated sqrt(Var[offset]). */
  se: number;
  /** Number of answers folded. */
  evidence: number;
}

/** Bernoulli likelihood of one outcome at a grid offset on the shared σ. */
function polyBinaryLikelihood(offset: number, bPrime: number, outcome: 0 | 1): number {
  const p = polySigmoid(offset - bPrime);
  return outcome === 1 ? p : 1 - p;
}

/**
 * Solve one KC's cold-start θ̂ from a locked difficulty anchor and ordered binary
 * answers. Pure; the Rust port is differential-verified with Object.is.
 *
 * @param bPrime b − θ_global (locked, never fit).
 * @param answers ordered outcomes (1 = correct).
 */
export function solveThetaOneKc(bPrime: number, answers: ReadonlyArray<0 | 1>): OneKcSolution {
  const mass = 1 / GRID_POINTS;
  let probs = new Array<number>(GRID_POINTS).fill(mass);

  for (let a = 0; a < answers.length; a++) {
    const outcome = answers[a];
    const unnorm = new Array<number>(GRID_POINTS);
    let total = 0;
    for (let i = 0; i < GRID_POINTS; i++) {
      const m = probs[i] * polyBinaryLikelihood(GRID_THETA[i], bPrime, outcome);
      unnorm[i] = m;
      total = total + m; // left fold, no reorder
    }
    if (!(total > 0)) {
      // Underflow over the whole grid: keep the prior shape, still count the answer.
      continue;
    }
    for (let i = 0; i < GRID_POINTS; i++) unnorm[i] = unnorm[i] / total;
    probs = unnorm;
  }

  let mean = 0;
  for (let i = 0; i < GRID_POINTS; i++) mean = mean + probs[i] * GRID_THETA[i];
  let varAcc = 0;
  for (let i = 0; i < GRID_POINTS; i++) {
    const d = GRID_THETA[i] - mean;
    varAcc = varAcc + probs[i] * (d * d);
  }
  return { thetaHat: mean, se: Math.sqrt(varAcc), evidence: answers.length };
}
