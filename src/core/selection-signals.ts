// YUK-361 Phase 1 — selection-signal maths. Cross-subject, pure, no IO.
//
// MFI = p(1−p), the 1PL item information. theta_precision downweights noisy ability
// estimates; KLP additionally integrates over posterior uncertainty for cold-start KCs.
// This module defines signals and scores; candidate collection and stream ordering live
// in Phase 3.

import { fisherInformation, thetaSe } from '@/core/theta';

/**
 * One candidate (question or paper). IRT fields share the logit scale; the candidate
 * collection layer supplies defaults, this lane only defines the shape.
 */
export interface SelectionCandidateSignal {
  refKind: 'question' | 'paper';
  refId: string;
  role: 'due' | 'frontier' | 'diagnostic' | 'new_check' | 'paper';
  /** Individual ability θ̂, logit scale. Cold start defaults to 0. */
  thetaHat?: number;
  /** Cumulative Fisher information; defaults to 1 (weak prior). */
  thetaPrecision?: number;
  /** IRT difficulty b, logit scale. */
  b?: number;
  /** Due-queue rank (FSRS), smaller is earlier. */
  dueRank?: number;
  /** Recall-locked variant; excluded from MFI scoring. */
  recallLocked?: boolean;
  /**
   * Provenance of `mfiScore`: point MFI, Gaussian KLP, or grid KLP. Grid wins when
   * available; recall-locked or missing θ̂/b leaves it undefined.
   */
  scoreKind?: 'mfi' | 'klp' | 'klp_grid';

  // ADR-0042 orchestration amendment: keep only signals with a real reader.
  // examRelevance has no cheap source yet; recurrence is implemented and flag-gated;
  // transferGap stays out until a per-(KC, context) reader exists.
  /** Syllabus relevance 0-1; deferred, no cheap reader. */
  examRelevance?: number;
  /**
   * Misconception recurrence 0-1 from mistake-family tallies, normalized by an
   * owner-fixed constant. Flag-gated and selection-only: never feeds θ̂/p(L)/FSRS.
   * Missing data is undefined, never zero-filled.
   */
  misconceptionRecurrence?: number;
}

/**
 * MFI: p(1−p) with p = σ(θ̂ − b). Reuses theta.ts's fisherInformation so selection and
 * precision accumulation share one item-information definition.
 */
export function mfiScore(thetaHat: number, b: number): number {
  return fisherInformation(thetaHat, b);
}

// A3 (YUK-435) — KLP cold-start score. Point MFI bets on one noisy θ̂; KLP integrates
// item information over the Gaussian posterior N(θ̂, SE²). The gain is modest and
// confined to cold start: as SE→0 the grid collapses to MFI. The gate below keeps it
// there.

/**
 * Master flag for KLP. True (live): cold-start KCs use klpScore, warm KCs keep point
 * MFI. False remains a valid, regression-anchored path (all candidates use MFI).
 */
export const EARLY_KLP_ENABLED = true;

/**
 * Cold-start regime length. Aligned with eloK's coldStartN=4: where θ̂ is most
 * volatile is where posterior weighting helps; above it KLP ≈ MFI anyway.
 */
export const EARLY_KLP_N = 4;

/** KLP grid: 21 points over ±3 SE (~99.7% posterior mass). */
const KLP_GRID_N = 21;
const KLP_GRID_HALF_WIDTH_SE = 3;

/**
 * Posterior-weighted Fisher information: Gaussian posterior N(θ̂, SE²), 21 equally
 * spaced points over ±3 SE, weights exp(−z²/2), return Σ wᵢ·I(θᵢ,b)/Σ wᵢ.
 * precision→∞ collapses to point MFI; low precision makes it conservative.
 */
export function klpScore(thetaHat: number, b: number, thetaPrecision: number): number {
  const se = thetaSe(thetaPrecision); // floors precision at 1e-9 → SE finite & > 0
  const lo = thetaHat - KLP_GRID_HALF_WIDTH_SE * se;
  const hi = thetaHat + KLP_GRID_HALF_WIDTH_SE * se;
  const step = (hi - lo) / (KLP_GRID_N - 1);
  let num = 0;
  let den = 0;
  for (let i = 0; i < KLP_GRID_N; i++) {
    const theta = lo + i * step;
    const z = (theta - thetaHat) / se;
    const w = Math.exp(-0.5 * z * z); // unnormalised Gaussian posterior weight
    num += w * fisherInformation(theta, b);
    den += w;
  }
  return num / den;
}

/**
 * Uncertainty discount ∈ (0,1): √precision/(1+√precision). Higher precision moves it
 * toward 1, so noisy estimates give less diagnostic value.
 */
export function uncertaintyPenalty(thetaPrecision: number): number {
  const s = Math.sqrt(Math.max(thetaPrecision, 1e-9));
  return s / (1 + s);
}

/** Diagnostic score: MFI discounted by uncertainty. */
export function diagnosticScore(thetaHat: number, b: number, thetaPrecision: number): number {
  return mfiScore(thetaHat, b) * uncertaintyPenalty(thetaPrecision);
}

/**
 * Softmax with adjustable temperature; lower is sharper. Stable by subtracting the
 * max, and fail-fast on a non-positive temperature or non-finite scores.
 *
 * Positivity guard: exp underflows to exact 0 below ~-744, which would make π_i=0 and
 * permanently exclude a candidate from IPW. Clamping the centred exponent at -700
 * keeps every finite score's weight strictly positive; normal ranges never hit the
 * clamp, and monotonicity survives because the clamp is non-decreasing.
 */
const CLAMP_K = 700;

export function softmaxProbabilities(scores: number[], temperature = 0.25): number[] {
  if (scores.length === 0) return [];
  if (!(temperature > 0)) {
    throw new Error(`softmaxProbabilities: temperature must be > 0, got ${temperature}`);
  }
  let max = Number.NEGATIVE_INFINITY;
  for (const s of scores) {
    if (!Number.isFinite(s)) {
      throw new Error(`softmaxProbabilities: non-finite score ${s}`);
    }
    if (s > max) max = s;
  }
  // Clamp keeps exp from underflowing to zero, preserving positivity for IPW.
  const exps = scores.map((s) => Math.exp(Math.max(-CLAMP_K, (s - max) / temperature)));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}
