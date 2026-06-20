// ─────────────────────────────────────────────────────────────────────────────
// A4 (YUK-436) — discrete grid-Bayes posterior over the per-KC θ_KC OFFSET.
//
// inc-1 is PURE-ADDITIVE SHADOW: we maintain a discrete posterior over the per-KC
// θ_KC OFFSET (the same offset the Elo path tracks as theta_hat), computed and
// PERSISTED shadow-only (no downstream reader in inc-1). Elo theta_hat stays the
// SOURCE OF TRUTH. The grid exists to validate calibration on live data before the
// invasive grid→SoT cut-over (inc-2, deferred — must serialize AFTER A3). The
// posterior yields a CALIBRATED standard error (posteriorSe) the point-estimate Elo
// precision/Fisher path cannot, which is the eventual payoff.
//
// ORTHOGONALITY TO A2 (hierarchical Elo): the grid is over the θ_KC OFFSET, with
//   θ_global as a TRANSLATION ANCHOR. The 1PL likelihood evaluates the item
//   characteristic curve at the EFFECTIVE ability = θ_global + θ_KC_offset, i.e. we
//   shift the item difficulty by θ_global: b' = b − θ_global. So the grid runs over
//   the SAME offset coordinate A2's per-KC layer uses, and θ_global merely translates
//   the likelihood. The grid does NOT subsume A2 (it does not model θ_global) and it
//   builds ON it (reads θ_global as the anchor). θ_global defaults 0 pre-A2 / reads
//   the A2 per-domain global post-A2 — at the wiring seam (state.ts).
//
// FLAG: THETA_GRID_ENABLED gates the whole thing as a module-level const (mirrors
//   SRT_ENABLED / HIERARCHICAL_ELO_ENABLED — NO config table, NO env). Default FALSE
//   this PR = dark-ship. When false, NO grid is computed or persisted: theta_hat +
//   precision + counts stay BYTE-IDENTICAL to today and theta_grid_json stays NULL
//   (the regression anchor the db tests pin with toBe + IS NULL).
//
// inc-1 likelihood = BINARY Bernoulli ONLY. A continuous-CB (signed-residual-time)
//   likelihood is written below but GATED — it is wired only when SRT_ENABLED &&
//   THETA_GRID_ENABLED (both true), which is NOT the case inc-1. It is stubbed-but-
//   correct so the cut-over (inc-2) can wire it without re-deriving the math.
//
// inc-1 runs the grid ONLY for single-KC items (knowledgeIds.length === 1). The
//   multi-KC conjunctive likelihood (a product over the touched KCs' offsets) is
//   DEFERRED — a single attempt's outcome is one Bernoulli draw shared across KCs, so
//   the per-KC posterior factorisation is non-trivial and not needed to validate
//   single-KC calibration. The wiring seam (state.ts) enforces the single-KC gate.
// ─────────────────────────────────────────────────────────────────────────────

import { expectedScore, fisherInformation } from './theta';

/**
 * Master flag for the discrete grid-Bayes θ_KC posterior. **Default false (dark-ship).**
 *
 * false → NO grid is computed or persisted anywhere. updateThetaForAttempt's tail
 *   shadow-write block is skipped entirely → theta_grid_json stays NULL and the Elo
 *   theta_hat / precision / counts are BYTE-IDENTICAL to today (regression anchor).
 * true  → for SINGLE-KC items only, the per-KC θ_KC offset posterior is updated by one
 *   sequential-Bayes step and PERSISTED shadow-only to mastery_state.theta_grid_json.
 *   NOTHING downstream reads it in inc-1 (it does not feed p(L) / effectiveB / selection).
 *
 * Flipped only at the inc-2 grid→SoT cut-over (deferred; must serialize AFTER A3),
 * after the shadow posterior is validated against the live Elo point estimate.
 */
export const THETA_GRID_ENABLED = false;

/**
 * Grid endpoints on the θ_KC OFFSET logit scale: [-4, 4]. The offset is the
 * deviation of per-KC ability from the (A2) per-domain anchor θ_global, so a ±4-logit
 * window comfortably brackets any plausible per-KC deviation (σ(±4) ≈ 0.018 / 0.982).
 */
export const GRID_MIN = -4;
export const GRID_MAX = 4;

/**
 * Number of grid points: 41 over [-4, 4] ⇒ a 0.2-logit step (GRID_STEP). 41 is odd so
 * a point lands EXACTLY on the offset origin 0 (index 20), the cold-start prior mode.
 */
export const GRID_POINTS = 41;

/** Logit step between adjacent grid points = (GRID_MAX − GRID_MIN) / (GRID_POINTS − 1) = 0.2. */
export const GRID_STEP = (GRID_MAX - GRID_MIN) / (GRID_POINTS - 1);

/**
 * The θ_KC OFFSET support points: [-4, -3.8, …, 0, …, 3.8, 4] (41 points, 0.2 step).
 * Frozen module constant — every posterior is a length-GRID_POINTS probability vector
 * aligned to this support.
 */
export const GRID_THETA: readonly number[] = Array.from(
  { length: GRID_POINTS },
  (_, i) => GRID_MIN + i * GRID_STEP,
);

/**
 * The shadow posterior persisted to mastery_state.theta_grid_json (inc-1). We store
 * ONLY the probability vector (the support is the frozen GRID_THETA module constant,
 * so persisting it would be redundant + drift-prone) plus the integer evidence count
 * (how many sequential-Bayes steps have folded in). posteriorMean / Var / Se are
 * DERIVED on read — never persisted (single source of truth, mirrors thetaSe deriving
 * SE from precision rather than storing it).
 */
export interface ThetaGridPosterior {
  /** length-GRID_POINTS probability mass over GRID_THETA; sums to 1 (normalised). */
  probs: number[];
  /** number of sequential-Bayes updates folded into this posterior (0 = pure prior). */
  evidence: number;
}

/**
 * The cold-start prior over the θ_KC OFFSET: UNIFORM over the 41 grid points (mass
 * 1/41 each). Uniform — not Gaussian-at-0 — keeps inc-1 assumption-light: the offset
 * prior is whatever the sequential likelihood folds in, with no extra shrinkage knob
 * to mis-tune before calibration validation. evidence = 0 (pure prior, no folds yet).
 */
export function uniformPrior(): ThetaGridPosterior {
  const mass = 1 / GRID_POINTS;
  return { probs: Array.from({ length: GRID_POINTS }, () => mass), evidence: 0 };
}

/**
 * Binary Bernoulli likelihood of one attempt outcome at a given θ_KC offset, under the
 * 1PL/Rasch ICC evaluated at the EFFECTIVE ability (θ_global anchor + offset). We pass
 * the DIFFICULTY-shifted anchor b' = b − θ_global so the likelihood reads:
 *
 *   p = σ(effective − b) = σ((θ_global + offset) − b) = σ(offset − (b − θ_global)) = σ(offset − b')
 *
 * i.e. `expectedScore(offset, bPrime)`. This is exactly the Elo path's likelihood with
 * the offset as the free coordinate and θ_global folded into the anchor — orthogonal
 * to A2, building ON its θ_global. correct ⇒ p, wrong ⇒ 1 − p.
 */
export function binaryLikelihood(offset: number, bPrime: number, outcome: 0 | 1): number {
  const p = expectedScore(offset, bPrime); // σ(offset − b') = σ((θ_global+offset) − b)
  return outcome === 1 ? p : 1 - p;
}

/**
 * GATED continuous-CB (signed-residual-time) likelihood STUB — NOT wired inc-1.
 *
 * The A1 continuous srtOutcome ∈ [0,1] is a soft correctness analog. Under the same
 * 1PL anchor, the continuous-Bernoulli (CB) likelihood at offset is the CB density with
 * mean tied to p = σ(offset − b'). For inc-1 we DO NOT wire this — it is reached only
 * when BOTH SRT_ENABLED && THETA_GRID_ENABLED (the state.ts seam keeps it gated). We
 * provide a correct-form stub (the soft-Bernoulli p^x·(1−p)^(1−x) interpolation, the
 * same family conjunctiveCreditsContinuous reduces to at the binary endpoints) so the
 * inc-2 cut-over can wire it without re-deriving the math.
 *
 * Reduces BIT-EXACTLY to binaryLikelihood at the binary endpoints (srt ∈ {0,1}):
 *   srt=1 ⇒ p^1·(1−p)^0 = p == binaryLikelihood(…, 1)
 *   srt=0 ⇒ p^0·(1−p)^1 = 1−p == binaryLikelihood(…, 0)
 */
export function continuousCbLikelihood(offset: number, bPrime: number, srt: number): number {
  const p = expectedScore(offset, bPrime);
  // Soft-Bernoulli interpolation p^srt·(1−p)^(1−srt). Endpoints reproduce the binary
  // likelihood exactly; the interior is the (unnormalised-constant) CB kernel — the
  // posterior renormalises across the grid, so the missing CB normaliser C(p) cancels
  // as a per-offset factor only if C is offset-independent. inc-2 must confirm/wire the
  // exact CB normaliser; this stub is INTENTIONALLY not on any live path inc-1.
  return p ** srt * (1 - p) ** (1 - srt);
}

/**
 * One sequential-Bayes update step: posterior ∝ prior · likelihood(outcome | offset, b').
 *
 * n=1-LEGAL: this is single-learner sequential Bayes — the item difficulty b (hence b')
 * is a LOCKED external anchor (item-half locked, G4 red line: we never fit b), so the
 * only free parameter is the learner's per-KC offset. Each attempt folds one Bernoulli
 * likelihood into the running posterior; there is no cohort dimension and none is
 * needed (b is given, not estimated).
 *
 * Pure: returns a NEW posterior, never mutates the input. The result is renormalised so
 * `probs` sums to 1 (guards against float underflow: if the unnormalised mass is ~0 —
 * a likelihood that vanishes over the whole grid — we fall back to the prior rather than
 * dividing by zero, keeping the posterior a valid distribution).
 */
export function gridUpdate(
  prior: ThetaGridPosterior,
  bPrime: number,
  outcome: 0 | 1,
): ThetaGridPosterior {
  const unnorm = prior.probs.map(
    (mass, i) => mass * binaryLikelihood(GRID_THETA[i], bPrime, outcome),
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

// ─────────────────────────────────────────────────────────────────────────────
// A4 inc-2 (YUK-436) — grid→selection wiring: posterior-weighted Fisher information
// over the ACTUAL discrete grid posterior (the calibrated payoff over the Gaussian
// approximation in selection-signals.klpScore).
//
// selection-signals.klpScore integrates Fisher over a Gaussian θ ~ Normal(θ̂, SE²)
// reconstructed from the Elo `theta_precision` — an APPROXIMATION of the posterior. The
// grid already IS the posterior (a length-GRID_POINTS pmf over the θ_KC offset), so when
// it is available we can take the EXACT posterior-weighted Fisher integral instead of
// re-approximating. This is the A4 "免费 Fisher 选题" payoff named in the issue.
//
// DARK-SHIP: this function is PURE + always callable, but its ONLY caller
// (candidate-signals.ts) is gated behind THETA_GRID_ENABLED (default false), so it is a
// complete NO-OP on the live selection path until the grid→SoT cut-over is flipped after
// calibration validation. Wiring the reader now (flag off) does not change any live score.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Posterior-weighted Fisher information over the grid posterior of the θ_KC OFFSET.
 *
 *   score = Σ_i probs_i · fisherInformation(θ_global + GRID_THETA_i, b)
 *
 * The grid runs over the OFFSET; the effective ability at grid point i is
 * `θ_global + GRID_THETA_i` (the same anchor the write-path likelihood uses via
 * b' = b − θ_global — see binaryLikelihood). `b` is the item difficulty (LOCKED anchor,
 * never fit). `probs` already sum to 1 (gridUpdate renormalises), so this is a true
 * expectation — no extra normalisation needed.
 *
 * Relationship to the Gaussian klpScore (selection-signals.ts):
 *   - a posterior concentrated on one offset reduces to point Fisher at that effective
 *     ability (== mfiScore when that point is θ̂);
 *   - a spread posterior down-weights the peak with the surrounding lower-information
 *     offsets ⇒ more conservative, exactly the KLP intent — but driven by the REAL
 *     posterior shape rather than a Gaussian(θ̂, thetaSe) stand-in.
 *
 * Range: fisherInformation ∈ (0, 0.25] and a convex combination stays in (0, 0.25].
 * Pure, zero IO, shares the single `fisherInformation` truth with mfiScore/klpScore.
 */
export function klpScoreFromGrid(
  posterior: ThetaGridPosterior,
  b: number,
  thetaGlobal: number,
): number {
  return posterior.probs.reduce(
    (acc, mass, i) => acc + mass * fisherInformation(thetaGlobal + GRID_THETA[i], b),
    0,
  );
}
