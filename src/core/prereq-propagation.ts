// A6 (YUK-442) — prerequisite directed soft propagation over per-KC ability θ̂.
//
// Pure, no IO, cross-subject (core/ boundary). The DIRECTED complement to A5's
// symmetric Laplacian (graph-laplacian.ts): a prerequisite edge k₁→k₂ (k₁ is a
// prerequisite OF k₂) encodes the SOFT order belief P(master k₁) ≥ P(master k₂).
//   - 答对高阶 (dependent estimated ABOVE its prereq) → RETRO-CREDIT the prereq up
//     (cheap implicit evidence: demonstrating the advanced skill implies the prereq).
//   - 答错先修 / 前置弱 (prereq below the dependent) → PRESS the dependent down
//     (you likely can't do k₂ if you don't know its prerequisite k₁).
//
// ── HARD CONSTRAINTS (YUK-442 dossier + math dossier 2026-06-20) ──────────────
//
//   (1) SOFT ORDER PRIOR, NOT a hard constraint. A hard order constraint
//       (θ₂ ≤ θ₁ enforced) on LLM-generated edges is TOO STRONG — a wrong edge would
//       SILENTLY corrupt firm-up. We soften to an additive, one-directional PENALTY
//       /credit driven by the ordering VIOLATION; edges are revisable (this is a
//       READ-side recompute, never written to mastery_state, so a corrected edge
//       immediately re-projects — see mastery/state.ts wiring).
//
//   (2) DIRECTED edges ONLY: `prerequisite` (and `derived_from` as directed
//       inheritance, normalised by the caller). `related_to` (symmetric → A5) and
//       `contrasts_with` (reverse signal) are EXCLUDED. This module is orientation-
//       normalised: every DirectedEdge is {from: PREREQ, to: DEPENDENT}; the wiring
//       layer maps relation_type → that orientation (prerequisite: from→to;
//       derived_from: to→from, since "from 派生自 to" makes the base `to` the prereq).
//
//   (3) SOFT LAYER — mean-only, READ-side. Returns an ADDITIVE Δθ per node applied to
//       the surfaced θ̂ MEAN only; the per-KC standard error / variance is left
//       untouched (ADR-0035 corollary — do not pass off an uncalibrated propagated
//       confidence as hard). Never writes mastery_state.theta_hat — the三维正交 red
//       line keeps the calibration axis clean (propagation is a diagnostic/selection
//       projection, not baked evidence).
//
//   (4) λ→0 退回独立: with both strengths 0 the adjustment is identically 0 (θ̃ = θ̂).
//
// n=1 admissible: consumes ONLY the single learner's own θ̂ + KG edge weights
//   (owner/LLM-supplied FIXED priors) + owner-fixed λ constants. No a/slip/guess/φ,
//   no cross-learner fit. λ MUST stay owner-supplied — learning λ from data would need
//   cross-subject variance (inadmissible, red line), so it is hardcoded behind a flag.
//
// PHASE-DEFERRED — λ_down / λ_up are conservative owner-supplied placeholders, NOT
//   calibrated truth. Retro-credit (up) is weaker than the downstream press (down),
//   mirroring the common "答错的诊断信息量 > 答对" PFA intuition; this is placeholder
//   direction, tuned later behind the dark flag.

/**
 * FLAG — A6 prerequisite directed propagation of the surfaced per-KC ability θ̂.
 *
 * Module-level const dark-ship flag (mirrors GRAPH_LAPLACIAN_ENABLED / SRT_ENABLED).
 * Default FALSE: getMasteryProjection is BYTE-IDENTICAL to today (no prereq edge
 * fetch, no Δθ). The "act flip" is gated on the A6 validation gate; the wiring is
 * built + electrified to live now (defer-flip, not defer-build).
 */
export const PREREQ_PROPAGATION_ENABLED = false;

/**
 * PHASE-DEFERRED — downstream-press strength λ_down (owner-supplied fixed prior).
 * How hard a WEAK prerequisite presses its dependent's estimate down per unit of
 * ordering violation × edge weight. Conservative default.
 */
export const PREREQ_PROP_LAMBDA_DOWN = 0.3;

/**
 * PHASE-DEFERRED — retro-credit strength λ_up (owner-supplied fixed prior).
 * How much a MASTERED dependent retro-credits its prerequisite up per unit of
 * ordering violation × edge weight. Weaker than λ_down (答对 ≺ 答错 information).
 */
export const PREREQ_PROP_LAMBDA_UP = 0.15;

/**
 * A directed prerequisite edge, orientation-NORMALISED so `from` is always the
 * PREREQUISITE and `to` the DEPENDENT (from must be mastered before to). The wiring
 * layer is responsible for mapping each relation_type to this orientation.
 */
export interface DirectedEdge {
  /** the prerequisite KC (must be mastered first). */
  from: string;
  /** the dependent KC (builds on `from`). */
  to: string;
  /** edge confidence ∈ (0,1]; modulates propagation strength. Defaults to 1. */
  weight?: number;
}

/**
 * Compute the additive per-node ability adjustment Δθ from directed prerequisite
 * edges. For each edge prereq→dependent with weight w:
 *
 *   violation = max(0, θ̂[dependent] − θ̂[prereq])   // ordering breach: dependent > prereq
 *   Δθ[dependent] += −λ_down · w · violation         // press the dependent DOWN
 *   Δθ[prereq]    += +λ_up   · w · violation         // retro-credit the prereq UP
 *
 * The `max(0, …)` makes it ONE-DIRECTIONAL: when the order already holds
 * (dependent ≤ prereq) the edge contributes nothing. Both directions are driven by
 * the SAME violation magnitude but with independent strengths. Nodes absent from
 * `thetaHat` are treated as latent at `priorMean` (default 0). A node with NO edge
 * gets Δθ = 0 (absent from the returned map ⇒ caller adds 0).
 *
 * Pure — returns a fresh Map of node id → Δθ (only nodes with a non-zero adjustment).
 * λ_down = λ_up = 0 ⇒ empty map (退回独立 / identity).
 */
export function prereqAdjustments(
  thetaHat: Map<string, number>,
  edges: DirectedEdge[],
  lambdaDown: number,
  lambdaUp: number,
  priorMean = 0,
): Map<string, number> {
  const delta = new Map<string, number>();
  const add = (id: string, v: number) => {
    if (v === 0) return;
    delta.set(id, (delta.get(id) ?? 0) + v);
  };
  for (const e of edges) {
    if (e.from === e.to) continue; // degenerate self-edge
    const w = e.weight ?? 1;
    if (!(w > 0)) continue;
    const tDep = thetaHat.get(e.to) ?? priorMean;
    const tPre = thetaHat.get(e.from) ?? priorMean;
    const violation = Math.max(0, tDep - tPre); // dependent estimated above its prereq
    if (violation === 0) continue;
    add(e.to, -lambdaDown * w * violation); // press dependent down
    add(e.from, lambdaUp * w * violation); // retro-credit prereq up
  }
  return delta;
}

/**
 * Apply {@link prereqAdjustments} and return the adjusted θ̃ per node (θ̂ + Δθ) for
 * the requested node set. Nodes with no adjustment pass through unchanged. Pure.
 */
export function propagatePrereq(
  nodeIds: string[],
  thetaHat: Map<string, number>,
  edges: DirectedEdge[],
  lambdaDown: number,
  lambdaUp: number,
  priorMean = 0,
): Map<string, number> {
  const delta = prereqAdjustments(thetaHat, edges, lambdaDown, lambdaUp, priorMean);
  const out = new Map<string, number>();
  for (const id of nodeIds) {
    const base = thetaHat.get(id) ?? priorMean;
    out.set(id, base + (delta.get(id) ?? 0));
  }
  return out;
}
