// YUK-495 Phase 1 (#125 rider) — one-KC cold-start θ̂ solver on the SHARED polynomial σ.
//
// WHY (sketch §6 / §7 binding rider): #125's full multi-KC coupled MAP/EM is Phase 3,
// but its largest NEW determinism risk — the grid-fold accumulation order + convergence —
// must be retired EARLY via a non-UI one-KC differential test. For ONE KC there is no
// latent cross-KC coupling, so the "EM" collapses to sequential-Bayes grid folding:
// uniformPrior → fold one Bernoulli likelihood per answer → posterior mean/SE. This is
// the determinism-clean core of #125; the coupled message-passing sweep layers on top
// (Phase 3) and inherits this fold's contract.
//
// DETERMINISM CONTRACT (the EM sweep-order spec, one-KC scope — ported verbatim to Rust):
//   - Frozen support GRID_THETA (41 pts on [-4,4], step (8/40)), computed -4 + i·step both
//     sides — never a decimal literal table.
//   - Likelihood uses the SHARED `polySigmoid` (poly-exp.ts), NOT the live Math.exp
//     `expectedScore` — so the Rust port is `Object.is`-bit-exact (decision ②). This makes
//     the cold-start solver an isomorphic-core function from day one; the LIVE theta-grid.ts
//     stays Math.exp until the S3 swap (the two converge then).
//   - Fold order: answers in index 0..n; within each step the unnormalised mass is built
//     i=0..40, summed i=0..40 (left fold), then divided. NO FMA, no reordering.
//   - Underflow guard identical to gridUpdate: total ≤ 0 → keep prior shape, still count.
//   - posteriorMean/SE accumulate i=0..40 (Σ mass·θ then Σ mass·(θ−mean)²; SE=sqrt(var)).
//
// b is a LOCKED input anchor (b' = b − θ_global), never fit (G4 red line); only this
// learner's θ̂ offset is estimated → identifiable at n=1.

import { polySigmoid } from './poly-exp';
import { GRID_MAX, GRID_MIN, GRID_POINTS } from './theta-grid';

// GRID_STEP/GRID_THETA recomputed here from the same constants so the support is identical
// to theta-grid.ts AND to the Rust port (which builds it the same way) — not imported as a
// pre-materialised array, to keep the "-4 + i·step" construction the single shared form.
const GRID_STEP = (GRID_MAX - GRID_MIN) / (GRID_POINTS - 1);
const GRID_THETA: readonly number[] = Array.from(
  { length: GRID_POINTS },
  (_, i) => GRID_MIN + i * GRID_STEP,
);

export interface OneKcSolution {
  /** Posterior-mean offset θ̂ (logit), E[offset] over the grid. */
  thetaHat: number;
  /** Calibrated standard error sqrt(Var[offset]). */
  se: number;
  /** Number of answers folded. */
  evidence: number;
}

/** Bernoulli likelihood of one outcome at grid offset, on the SHARED poly σ. */
function polyBinaryLikelihood(offset: number, bPrime: number, outcome: 0 | 1): number {
  const p = polySigmoid(offset - bPrime);
  return outcome === 1 ? p : 1 - p;
}

/**
 * Solve one KC's cold-start θ̂ from a fixed difficulty anchor + a sequence of binary
 * answers, by sequential-Bayes grid folding on the shared polynomial σ. Pure; the bit-exact
 * Rust port (`solve_theta_one_kc`) is differential-verified against this oracle via Object.is.
 *
 * @param bPrime difficulty-shifted anchor b' = b − θ_global (LOCKED input, never fit).
 * @param answers ordered binary outcomes (1 = correct).
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
      total = total + m; // left fold i=0..40, no reorder
    }
    if (!(total > 0)) {
      // degenerate (underflow over the whole grid): keep prior shape, still count evidence.
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
