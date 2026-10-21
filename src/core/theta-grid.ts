// ─────────────────────────────────────────────────────────────────────────────
// A4 (YUK-436) — discrete grid-Bayes posterior over the per-KC θ offset.
//
// Shadow-only: Elo theta_hat remains the source of truth; THETA_GRID_ENABLED=false
// leaves theta_hat, precision, counts and theta_grid_json byte-identical. The grid
// exists to validate calibration before the deferred grid→SoT cut-over, and yields
// a calibrated SE the Elo precision path cannot.
//
// θ_global is a translation anchor, not a modelled layer: the likelihood sees the
// effective ability θ_global + offset, so b' = b − θ_global. Inc-1 folds binary
// Bernoulli outcomes for single-KC items only; the multi-KC conjunctive likelihood
// and continuous-CB likelihood are gated for the cut-over.
// ─────────────────────────────────────────────────────────────────────────────

import { expectedScore, fisherInformation3pl } from './theta';

/**
 * Master flag for the discrete grid-Bayes θ posterior. Default false: no grid is
 * computed or persisted, so the Elo fields stay byte-identical. When true, single-KC
 * items fold one sequential-Bayes step into mastery_state.theta_grid_json, shadow-only.
 */
export const THETA_GRID_ENABLED = false;

/**
 * Dark-ship flag for the day-one prerequisite prior read surface (not A6 θ
 * propagation). False makes loadDayOnePriors a no-op. The name deliberately differs
 * from the two existing PREREQ_PROPAGATION_* mechanisms; the native binding is
 * dev/CI-only, so the surface no-ops wherever the .node is absent.
 */
export const DAY_ONE_PRIOR_ENABLED = false;

/**
 * Offset grid endpoints. The offset is per-KC ability relative to the A2 domain
 * anchor; ±4 logits brackets any plausible deviation.
 */
export const GRID_MIN = -4;
export const GRID_MAX = 4;

/** 41 points over [-4, 4] (0.2 step); odd so one point lands exactly on offset 0. */
export const GRID_POINTS = 41;

/** Logit step between adjacent grid points. */
export const GRID_STEP = (GRID_MAX - GRID_MIN) / (GRID_POINTS - 1);

/** Frozen support for every length-GRID_POINTS posterior vector. */
export const GRID_THETA: readonly number[] = Array.from(
  { length: GRID_POINTS },
  (_, i) => GRID_MIN + i * GRID_STEP,
);

/**
 * Shadow posterior persisted to mastery_state.theta_grid_json. Only probabilities and
 * the fold count are stored; mean/variance/SE are derived on read.
 */
export interface ThetaGridPosterior {
  /** length-GRID_POINTS probability mass over GRID_THETA; sums to 1 (normalised). */
  probs: number[];
  /** number of sequential-Bayes updates folded into this posterior (0 = pure prior). */
  evidence: number;
}

/** Uniform prior over the 41 offsets; assumption-light by design. */
export function uniformPrior(): ThetaGridPosterior {
  const mass = 1 / GRID_POINTS;
  return { probs: Array.from({ length: GRID_POINTS }, () => mass), evidence: 0 };
}

/**
 * Bernoulli likelihood at an offset under the shared 1PL ICC evaluated at the
 * effective ability: p = σ(offset − b'). `c` is the structural guess rate.
 *
 * c ∈ [0, 1): choicesToGuess only returns {0} ∪ (0, 1/2]. c=1 is out of domain and
 * degrades only through gridUpdate's total>0 guard. Never source c from irt_c; it is
 * derived from choices_md, not fitted.
 */
export function binaryLikelihood(offset: number, bPrime: number, outcome: 0 | 1, c = 0): number {
  // 3PL lower asymptote: c=0 delegates to the 1PL path for the byte-identical anchor.
  // c>0 is the choice-question guess rate; c is derived from choices_md, never fitted.
  if (c === 0) {
    const p = expectedScore(offset, bPrime);
    return outcome === 1 ? p : 1 - p;
  }
  const phat = expectedScore(offset, bPrime);
  return outcome === 1 ? c + (1 - c) * phat : (1 - c) * (1 - phat);
}

/**
 * Structural 3PL guess rate from choices_md: c = 1/k. Fewer than two options (null,
 * empty, single-choice placeholder) means c=0, so the 1PL path is byte-identical.
 * Not wired into a live caller until the grid→SoT cut-over.
 */
export function choicesToGuess(choices: readonly string[] | null | undefined): number {
  if (!choices || choices.length < 2) return 0; // 非选择题 → 1PL 退化
  return 1 / choices.length;
}

/**
 * GATED continuous-Bernoulli likelihood stub, not wired in inc-1. It reproduces the
 * binary likelihood byte-exactly at srt ∈ {0,1}; the interior lacks the CB normaliser,
 * which inc-2 must confirm before wiring. Reached only with SRT_ENABLED && THETA_GRID_ENABLED.
 */
export function continuousCbLikelihood(offset: number, bPrime: number, srt: number): number {
  const p = expectedScore(offset, bPrime);
  // Soft-Bernoulli interpolation. Endpoints match the binary likelihood exactly; the
  // missing CB normaliser may cancel only if it is offset-independent — inc-2 must verify.
  return p ** srt * (1 - p) ** (1 - srt);
}

/**
 * One sequential-Bayes update: posterior ∝ prior · likelihood(outcome | offset, b').
 *
 * n=1 legal: b is a locked external anchor, so the only free parameter is the
 * learner's offset. Pure; returns a new posterior. Underflow falls back to the prior
 * shape while still counting the attempt.
 */
export function gridUpdate(
  prior: ThetaGridPosterior,
  bPrime: number,
  outcome: 0 | 1,
  c = 0,
): ThetaGridPosterior {
  const unnorm = prior.probs.map(
    (mass, i) => mass * binaryLikelihood(GRID_THETA[i], bPrime, outcome, c),
  );
  const total = unnorm.reduce((acc, m) => acc + m, 0);
  if (!(total > 0)) {
    // Degenerate likelihood (underflow over the whole grid) — keep the prior shape +
    // still count the evidence fold (the attempt happened) rather than emit NaNs.
    return { probs: [...prior.probs], evidence: prior.evidence + 1 };
  }
  return {
    probs: unnorm.map((m) => m / total),
    evidence: prior.evidence + 1,
  };
}

/** Posterior mean E[offset] = Σ probs_i · GRID_THETA_i (the calibrated point estimate). */
export function posteriorMean(posterior: ThetaGridPosterior): number {
  return posterior.probs.reduce((acc, mass, i) => acc + mass * GRID_THETA[i], 0);
}

/** Posterior variance Var[offset] = Σ probs_i · (GRID_THETA_i − mean)² (≥ 0). */
export function posteriorVar(posterior: ThetaGridPosterior): number {
  const mean = posteriorMean(posterior);
  return posterior.probs.reduce((acc, mass, i) => acc + mass * (GRID_THETA[i] - mean) ** 2, 0);
}

/**
 * Posterior standard error = √Var — the CALIBRATED SE the grid yields (the eventual
 * payoff over the Elo point estimate's Fisher-derived SE). Derived, never persisted.
 */
export function posteriorSe(posterior: ThetaGridPosterior): number {
  return Math.sqrt(posteriorVar(posterior));
}

// A4 inc-2 (YUK-436) — posterior-weighted Fisher over the actual grid posterior.
// selection-signals.klpScore approximates this with Gaussian(θ̂, SE²); when the grid is
// available it is the posterior, so the integral needs no re-approximation. Dark until
// the grid→SoT cut-over flips THETA_GRID_ENABLED.

/**
 * Posterior-weighted Fisher information over the offset posterior:
 * score = Σ probs_i · fisherInformation(θ_global + GRID_THETA_i, b).
 * b is the locked item anchor; probs already sum to 1. Range (0, 0.25].
 */
export function klpScoreFromGrid(
  posterior: ThetaGridPosterior,
  b: number,
  thetaGlobal: number,
  c = 0,
): number {
  // c=0 delegates to the 1PL Fisher for the byte-identical anchor; c>0 uses 3PL.
  return posterior.probs.reduce(
    (acc, mass, i) => acc + mass * fisherInformation3pl(thetaGlobal + GRID_THETA[i], b, c),
    0,
  );
}

// BKT graft 2 (YUK-436) — mastery-transition detection derived from the posterior
// trajectory. Per KC, a rolling window tracks p_mastery (mass above θ*), width
// (posteriorSe), and evidence; graduation needs N consecutive hits, narrow width, and
// enough evidence.
//
// θ* must be a stable KC-level representative difficulty, never the current attempt's
// bPrime: a per-item threshold would move the mastery line on every question and make
// "N consecutive" meaningless. On the offset axis that KC-level threshold is still
// bPrime = b_KC − θ_global, so callers pass it without θ_global.
//
// Pure and dark: persistence, the KcGraduated event, and the item_calibration.b read
// are deferred to the grid→SoT cut-over.

/** Mastery derivatives recomputed by the caller; only the trajectory is persisted. */
export interface MasterySnapshot {
  /** Posterior mass above the mastery line (offset axis = bPrime). */
  pMastery: number;
  /** Posterior SE; smaller means a more trustworthy estimate. */
  width: number;
}

/** Graduation thresholds (handoff defaults; ε/M await real posterior widths). */
export interface GraduationConfig {
  /** p_mastery floor, default 0.8. */
  readonly pMasteryMin?: number;
  /** width ceiling ε on the offset axis, default 1.0 (placeholder). */
  readonly widthMax?: number;
  /** Consecutive hits, default 3. */
  readonly consecutiveN?: number;
  /** Evidence floor, default 8. */
  readonly evidenceMin?: number;
}

/** Posterior mass at or above the offset threshold (the mastery line bPrime). */
export function posteriorMassAbove(posterior: ThetaGridPosterior, thresholdOffset: number): number {
  return posterior.probs.reduce(
    (acc, mass, i) => acc + (GRID_THETA[i] >= thresholdOffset ? mass : 0),
    0,
  );
}

/**
 * Compute p_mastery and width from one posterior. `bPrime` must be the stable KC-level
 * mastery line, not the current attempt's value.
 */
export function masterySnapshot(posterior: ThetaGridPosterior, bPrime: number): MasterySnapshot {
  return {
    pMastery: posteriorMassAbove(posterior, bPrime),
    width: posteriorSe(posterior),
  };
}

/**
 * Graduation needs enough evidence, a long enough trajectory, and N consecutive
 * snapshots above the mastery line with narrow width. `recent` is oldest→newest.
 */
export function isGraduationCandidate(
  posterior: ThetaGridPosterior,
  recent: readonly MasterySnapshot[],
  cfg: GraduationConfig = {},
): boolean {
  const { pMasteryMin = 0.8, widthMax = 1.0, consecutiveN = 3, evidenceMin = 8 } = cfg;
  // Fail closed: consecutiveN <= 0 would make slice() empty and every() vacuously true.
  if (consecutiveN <= 0) return false;
  if (posterior.evidence < evidenceMin) return false;
  if (recent.length < consecutiveN) return false;
  const tail = recent.slice(recent.length - consecutiveN);
  return tail.every((s) => s.pMastery > pMasteryMin && s.width < widthMax);
}
