// A6 (YUK-442) — directed soft propagation over per-KC ability θ̂.
//
// The directed complement to A5: a prerequisite edge k₁→k₂ means P(master k₁) ≥
// P(master k₂). A dependent estimated above its prereq retro-credits the prereq;
// a weak prereq presses the dependent down. Constraints:
//   1. Soft order prior, not a hard constraint. LLM edges are revisable, so an
//      additive one-directional penalty driven by the violation is safer than
//      clamping θ; it is read-side only and never writes mastery_state.
//   2. Directed edges only. related_to belongs to A5; this module trusts the caller
//      to normalise every edge to {from: PREREQ, to: DEPENDENT}.
//   3. Mean only. The per-KC SE/variance is untouched; propagated confidence is not
//      calibrated evidence.
//   4. Both strengths 0 returns identity.
//
// λ_down/λ_up are owner-supplied fixed priors, not calibrated truth. Retro-credit is
// intentionally weaker than the downstream press; both stay behind the dark flag.

/**
 * Dark flag for A6 propagation. False leaves getMasteryProjection byte-identical
 * (no prereq fetch, no Δθ); the wiring is already live behind the flag.
 */
export const PREREQ_THETA_PROPAGATION_ENABLED = false;

/** Downstream-press strength λ_down (owner-fixed conservative prior). */
export const PREREQ_PROP_LAMBDA_DOWN = 0.3;

/** Retro-credit strength λ_up, weaker than the press (owner-fixed prior). */
export const PREREQ_PROP_LAMBDA_UP = 0.15;

/**
 * Directed edge, normalised so `from` is the prerequisite and `to` the dependent.
 * The wiring layer maps relation_type to this orientation.
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
 * Additive Δθ per node from directed prerequisite edges. For prereq→dependent with
 * weight w and violation = max(0, θ_dependent − θ_prereq):
 *
 *   Δθ[dependent] += −λ_down · w · violation
 *   Δθ[prereq]    += +λ_up   · w · violation
 *
 * One-directional: when the order already holds the edge contributes nothing. Nodes
 * absent from θHat are treated as priorMean. Returns only non-zero adjustments.
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

/** Apply {@link prereqAdjustments} to the requested nodes; unadjusted nodes pass through. */
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
