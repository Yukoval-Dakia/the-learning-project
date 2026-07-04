// YUK-559 (S3, worklist #6) — the kg-borrowing SHADOW sweep: a weekly, REPORT-ONLY,
// FLAG-INDEPENDENT shadow of the A5/A6 soft layer.
//
// PURPOSE (spec Q6′-L / RP7). The A5/A6 KG-borrowing soft layer is dark (both flags
// false), so today it produces ZERO data — a "wait for data before flipping the flag"
// dead loop. This sweep breaks it: it re-runs the SAME pure math (smoothThetaByComponent /
// propagatePrereq) the live path would run, over the live mastery_state + edges, WITHOUT
// checking the flags, and emits ONE summary event carrying the distribution the owner
// needs to decide the flip ("翻 A5/A6 会改多少 θ、多少 KC 会借、分量多大"). Data门只 gate
// 翻转不 gate build — the埋点 is electrified DURING dark.
//
// PAYLOAD SHAPE (C4/C5/C7 — this is a FOLD-INERT observation payload, zero consumers):
//   - THREE-VARIANT attribution {a5_only, a6_only, joint}: one shared A5 dense solve, then
//     a5_only = A5 θ̃, a6_only = propagatePrereq(bare θ̂), joint = propagatePrereq(A5 θ̃). The
//     owner sees each flag's marginal effect + the joint separately.
//   - quantiles are type-7 (linear interpolation, `@/core/theta` quantile) — same convention
//     as the rest of the codebase; min/max are the sorted endpoints.
//   - the component-size histogram buckets are DERIVED from the component cap (powers of two
//     up to the first ≥ cap, then one overflow bucket); component metrics are top-level (A5
//     structural quantities), reported once — not per variant.
//
// SAFETY INVARIANTS:
//   - FLAG-INDEPENDENT but READ-ONLY: it never writes mastery_state / knowledge_edge; its
//     ONLY write is ONE fold-inert summary event (subject_kind 'kg_borrow_shadow', queried
//     by NO gather → structurally fold-inert). It mirrors the live path's STRUCTURAL gating
//     (A5 runs iff related_to edges present; A6 iff directed edges present) but omits the
//     dark FLAG check — so it computes the counterfactual, never changes live behaviour.
//   - ingest_at = now (ADR-0021 opt-out): a forensic/experimental breadcrumb, NOT user
//     activity — without the stamp the memory outbox poller (WHERE ingest_at IS NULL) would
//     feed it to Mem0 + brief-regen (F1).
//   - threshold_deferred: the payload constants (λ/κ/λ_down/λ_up/cap) are owner-fixed n=1
//     priors, snapshotted with each event so the owner can re-read the distribution later;
//     no live behaviour is gated on this event.
//   - COMPONENT CAP: A5 partitions by related_to connected component and SKIPS any component
//     over SHADOW_BORROW_COMPONENT_CAP (the skipped sizes ARE the RP8 scale data the owner
//     wants). Aligned with the live guard's GRAPH_SMOOTH_COMPONENT_CAP (M3′).
//   - DARK-SHIP RESILIENCE: the whole run is wrapped — a compute or emit failure logs and
//     degrades to NO-OP (mirror propagate-priors.ts). The shadow is pure observability
//     (no consumer), so a missed week is acceptable; it must never crash the worker.

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import {
  GRAPH_LAPLACIAN_ENABLED,
  GRAPH_LAPLACIAN_KAPPA,
  GRAPH_LAPLACIAN_LAMBDA,
  GRAPH_SMOOTH_COMPONENT_CAP,
  type SymmetricEdge,
  smoothThetaByComponent,
} from '@/core/graph-laplacian';
import { newId } from '@/core/ids';
import {
  type DirectedEdge,
  PREREQ_PROP_LAMBDA_DOWN,
  PREREQ_PROP_LAMBDA_UP,
  PREREQ_THETA_PROPAGATION_ENABLED,
  propagatePrereq,
} from '@/core/prereq-propagation';
import { quantile } from '@/core/theta';
import type { Db } from '@/db/client';
import { knowledge_edge, mastery_state } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
// C9 single source — the borrow epsilon, admitted relation-type set, and edge split are the
// live soft layer's (state.ts) exports so the shadow can never drift from the live path.
import {
  BORROW_EPS,
  PROJECTION_EDGE_RELATION_TYPES,
  splitProjectionEdgeRows,
} from '@/server/mastery/state';

export const KG_BORROW_SHADOW_ACTION = 'experimental:kg_borrow_shadow';
export const KG_BORROW_SHADOW_SUBJECT_KIND = 'kg_borrow_shadow';
// One summary event per run — a fixed subject id keeps the breadcrumb query-stable.
export const KG_BORROW_SHADOW_SUBJECT_ID = 'global';

// Aligned with the live A5 guard's cap (M3′). Same OWNER-FIXED 未经数据校准的保守初值 —
// a divergence between the shadow's projected skip set and the live guard's would make the
// shadow lie about the flip, so they share the same constant.
export const SHADOW_BORROW_COMPONENT_CAP = GRAPH_SMOOTH_COMPONENT_CAP;

interface ObservedNode {
  theta_hat: number;
  theta_precision: number;
}

export interface QuantileSummary {
  min: number;
  p50: number;
  p90: number;
  p99: number;
  max: number;
}

/**
 * Deterministic quantile summary over an UNSORTED sample (null if empty). Pure.
 *
 * C4 — p50/p90/p99 use the shared `@/core/theta` `quantile` (type-7 / linear interpolation
 * between order statistics, the Excel PERCENTILE convention) so the sweep reports the SAME
 * quantile convention the rest of the codebase uses; `min`/`max` are the sorted endpoints.
 */
export function quantileSummary(sample: number[]): QuantileSummary | null {
  if (sample.length === 0) return null;
  const sorted = [...sample].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
  };
}

/**
 * Bucket component sizes into a bounded power-of-two histogram whose boundaries are DERIVED
 * from `cap` (C7): `<=1, <=2, <=4, …` up to the first power of two ≥ `cap`, then a single
 * `>N` overflow bucket. With `cap`=256 the boundaries are `[1,2,4,8,16,32,64,128,256]` + `>256`
 * (byte-for-byte the prior hardcoded set). Pure.
 */
export function componentHistogram(sizes: number[], cap: number): Record<string, number> {
  // Power-of-two boundaries up to the first ≥ cap (so the top bucket always covers the cap).
  const buckets: number[] = [];
  let b = 1;
  while (b < cap) {
    buckets.push(b);
    b *= 2;
  }
  buckets.push(b); // first power of two ≥ cap
  const overflowLabel = `>${buckets[buckets.length - 1]}`;
  const h: Record<string, number> = {};
  for (const s of sizes) {
    let label = overflowLabel;
    for (const bound of buckets) {
      if (s <= bound) {
        label = `<=${bound}`;
        break;
      }
    }
    h[label] = (h[label] ?? 0) + 1;
  }
  return h;
}

/** Per-variant move/borrow summary (C5 — one per A5-only / A6-only / joint counterfactual). */
export interface VariantStats {
  observed_moved_count: number;
  would_borrow_count: number;
  /** Δθ (θ̃ − θ̂) magnitude distribution over MOVED observed KCs. */
  delta_theta: QuantileSummary | null;
  /** the borrowed θ̃ distribution over would-borrow (unobserved) KCs. */
  borrowed_theta: QuantileSummary | null;
}

export interface ShadowBorrowStats {
  observed_count: number;
  /** A5 ONLY — the symmetric graph-Laplacian smoothing counterfactual (bare θ̂ in). */
  a5_only: VariantStats;
  /** A6 ONLY — the directed prereq-propagation counterfactual over the bare θ̂. */
  a6_only: VariantStats;
  /** JOINT — A5 smoothing THEN A6 propagation (what the live soft layer would do). */
  joint: VariantStats;
  // Component metrics are A5 STRUCTURAL quantities (the related_to partition) — reported ONCE
  // at the top level (not per variant): they describe the graph, not a counterfactual.
  component_count: number;
  component_size_max: number;
  component_size_histogram: Record<string, number>;
  skipped_components: number;
  skipped_component_sizes: number[];
}

/**
 * PURE — summarise one variant's θ̃ against the bare observed θ̂: count moved observed KCs
 * (|Δθ| > BORROW_EPS), would-borrow unobserved KCs (|θ̃| > BORROW_EPS), and their quantile
 * distributions. Deterministic, no IO.
 */
function summariseVariant(
  nodeIds: string[],
  thetaTilde: Map<string, number>,
  observed: Map<string, ObservedNode>,
): VariantStats {
  const deltas: number[] = [];
  const borrowed: number[] = [];
  for (const id of nodeIds) {
    const tilde = thetaTilde.get(id);
    if (tilde === undefined) continue;
    const obs = observed.get(id);
    if (obs) {
      const delta = tilde - obs.theta_hat;
      if (Math.abs(delta) > BORROW_EPS) deltas.push(Math.abs(delta));
    } else if (Math.abs(tilde) > BORROW_EPS) {
      // Unobserved node that borrowed a non-trivial θ̃ → would materialise a borrowed entry.
      borrowed.push(tilde);
    }
  }
  return {
    observed_moved_count: deltas.length,
    would_borrow_count: borrowed.length,
    delta_theta: quantileSummary(deltas),
    borrowed_theta: quantileSummary(borrowed),
  };
}

/**
 * PURE — the shadow computation (C5 THREE-VARIANT ATTRIBUTION): given the observed KC states +
 * typed edges, run ONE shared dense A5 solve and attribute the borrow effect three ways:
 *   - `a5_only`: the A5 smoothed θ̃ (symmetric graph-Laplacian only).
 *   - `a6_only`: `propagatePrereq(bare θ̂)` (directed prereq propagation only).
 *   - `joint`  : `propagatePrereq(A5-smoothed θ̃)` (what the live soft layer would produce).
 * STRUCTURAL gating (mirrors applyKgSoftLayer, flags omitted): no symmetric edges ⇒ A5
 * degenerates (a5_only ≡ identity, joint ≡ a6_only); no directed edges ⇒ a6_only ≡ identity,
 * joint ≡ a5_only. Component metrics are the A5 partition structure, reported once. Deterministic,
 * no IO. Exported for unit tests.
 */
export function computeShadowBorrowStats(
  observed: Map<string, ObservedNode>,
  symmetric: SymmetricEdge[],
  directed: DirectedEdge[],
  componentCap: number,
): ShadowBorrowStats {
  // Node set = observed ∪ edge endpoints (unobserved endpoints borrow from observed).
  const nodeIdSet = new Set<string>(observed.keys());
  for (const e of symmetric) {
    nodeIdSet.add(e.a);
    nodeIdSet.add(e.b);
  }
  for (const e of directed) {
    nodeIdSet.add(e.from);
    nodeIdSet.add(e.to);
  }
  const nodeIds = [...nodeIdSet];
  const thetaHat = new Map<string, number>();
  const observationPrecision = new Map<string, number>();
  for (const [id, node] of observed) {
    thetaHat.set(id, node.theta_hat);
    observationPrecision.set(id, node.theta_precision);
  }

  // A5 — the SINGLE shared dense solve. Degenerate (a5Theta ≡ θ̂) when no symmetric edges.
  let a5Theta = thetaHat;
  let componentSizes: number[] = nodeIds.map(() => 1); // default: singletons (no A5 run)
  let skippedComponentSizes: number[] = [];
  if (symmetric.length > 0) {
    const smoothed = smoothThetaByComponent(
      nodeIds,
      symmetric,
      thetaHat,
      observationPrecision,
      GRAPH_LAPLACIAN_LAMBDA,
      GRAPH_LAPLACIAN_KAPPA,
      componentCap,
    );
    a5Theta = smoothed.theta;
    componentSizes = smoothed.componentSizes;
    skippedComponentSizes = smoothed.skippedComponentSizes;
  }
  // A6 — propagatePrereq is PURE (fresh map): a6_only over bare θ̂, joint over the A5 θ̃.
  const a6Theta =
    directed.length > 0
      ? propagatePrereq(nodeIds, thetaHat, directed, PREREQ_PROP_LAMBDA_DOWN, PREREQ_PROP_LAMBDA_UP)
      : thetaHat;
  const jointTheta =
    directed.length > 0
      ? propagatePrereq(nodeIds, a5Theta, directed, PREREQ_PROP_LAMBDA_DOWN, PREREQ_PROP_LAMBDA_UP)
      : a5Theta;

  return {
    observed_count: observed.size,
    a5_only: summariseVariant(nodeIds, a5Theta, observed),
    a6_only: summariseVariant(nodeIds, a6Theta, observed),
    joint: summariseVariant(nodeIds, jointTheta, observed),
    component_count: componentSizes.length,
    // C6 — reduce-based max (never Math.max(...spread): a whole-tree partition can exceed the
    // JS argument-count limit and throw RangeError).
    component_size_max: componentSizes.reduce((m, s) => (s > m ? s : m), 0),
    component_size_histogram: componentHistogram(componentSizes, componentCap),
    skipped_components: skippedComponentSizes.length,
    skipped_component_sizes: [...skippedComponentSizes].sort((a, b) => a - b),
  };
}

export interface KgBorrowShadowReport extends ShadowBorrowStats {
  /** true when the run was a no-op (empty graph → no summary event written). */
  noop: boolean;
  /** the summary event id, or null on no-op / failure. */
  eventId: string | null;
}

const EMPTY_VARIANT: VariantStats = {
  observed_moved_count: 0,
  would_borrow_count: 0,
  delta_theta: null,
  borrowed_theta: null,
};

const EMPTY_STATS: ShadowBorrowStats = {
  observed_count: 0,
  a5_only: EMPTY_VARIANT,
  a6_only: EMPTY_VARIANT,
  joint: EMPTY_VARIANT,
  component_count: 0,
  component_size_max: 0,
  component_size_histogram: {},
  skipped_components: 0,
  skipped_component_sizes: [],
};

export interface RunKgBorrowShadowSweepOpts {
  now?: Date;
  /** TEST-ONLY: override the component cap so a small seeded graph can trip the skip path. */
  componentCap?: number;
}

/**
 * Load the live mastery_state 'knowledge' rows + typed edges, run the shadow computation,
 * and emit ONE summary event. FLAG-INDEPENDENT. DARK-SHIP RESILIENCE: any failure logs +
 * degrades to NO-OP (never throws — pure observability, no consumer).
 *
 * Empty graph (no observed rows) → NO-OP (no event). Otherwise emits one
 * `experimental:kg_borrow_shadow` event with ingest_at = now (memory opt-out).
 */
export async function runKgBorrowShadowSweep(
  db: Db,
  opts: RunKgBorrowShadowSweepOpts = {},
): Promise<KgBorrowShadowReport> {
  const now = opts.now ?? new Date();
  const componentCap = opts.componentCap ?? SHADOW_BORROW_COMPONENT_CAP;
  try {
    const observedRows = await db
      .select({
        subject_id: mastery_state.subject_id,
        theta_hat: mastery_state.theta_hat,
        theta_precision: mastery_state.theta_precision,
      })
      .from(mastery_state)
      .where(eq(mastery_state.subject_kind, 'knowledge'));

    if (observedRows.length === 0) {
      console.log('[kg_borrow_shadow_sweep] no mastery_state rows — no-op');
      return { ...EMPTY_STATS, noop: true, eventId: null };
    }

    const observed = new Map<string, ObservedNode>(
      observedRows.map((r) => [
        r.subject_id,
        { theta_hat: r.theta_hat, theta_precision: r.theta_precision },
      ]),
    );

    // Load ALL live typed edges (archived_at IS NULL) — the shadow is global, so unlike the
    // live loadEdgesForProjection it has no incident-to-requested filter. C9: the admitted
    // relation set + split/orientation-normalise are state.ts's shared exports (single source).
    const edgeRows = await db
      .select({
        from_id: knowledge_edge.from_knowledge_id,
        to_id: knowledge_edge.to_knowledge_id,
        relation_type: knowledge_edge.relation_type,
        weight: knowledge_edge.weight,
      })
      .from(knowledge_edge)
      .where(
        and(
          isNull(knowledge_edge.archived_at),
          inArray(knowledge_edge.relation_type, [...PROJECTION_EDGE_RELATION_TYPES]),
        ),
      );
    const { symmetric, directed } = splitProjectionEdgeRows(edgeRows);

    const stats = computeShadowBorrowStats(observed, symmetric, directed, componentCap);

    const eventId = newId();
    await writeEvent(db, {
      id: eventId,
      actor_kind: 'system',
      actor_ref: 'kg_borrow_shadow_sweep',
      action: KG_BORROW_SHADOW_ACTION,
      subject_kind: KG_BORROW_SHADOW_SUBJECT_KIND,
      subject_id: KG_BORROW_SHADOW_SUBJECT_ID,
      outcome: null, // observation projection, never a judging outcome (red line).
      payload: {
        ...stats,
        // owner-fixed n=1 prior snapshot — re-readable from the distribution N weeks later.
        flags: {
          graph_laplacian_enabled: GRAPH_LAPLACIAN_ENABLED,
          prereq_theta_propagation_enabled: PREREQ_THETA_PROPAGATION_ENABLED,
        },
        consts: {
          lambda: GRAPH_LAPLACIAN_LAMBDA,
          kappa: GRAPH_LAPLACIAN_KAPPA,
          lambda_down: PREREQ_PROP_LAMBDA_DOWN,
          lambda_up: PREREQ_PROP_LAMBDA_UP,
          component_cap: componentCap,
        },
        threshold_deferred: true,
      },
      caused_by_event_id: null,
      // ADR-0021 memory opt-out (F1): forensic breadcrumb, not user activity.
      ingest_at: now,
      created_at: now,
    });

    console.log('[kg_borrow_shadow_sweep] done', {
      observed: stats.observed_count,
      jointMoved: stats.joint.observed_moved_count,
      jointWouldBorrow: stats.joint.would_borrow_count,
      skippedComponents: stats.skipped_components,
    });
    return { ...stats, noop: false, eventId };
  } catch (err) {
    // DARK-SHIP RESILIENCE (mirror propagate-priors.ts): shadow is pure observability with no
    // consumer — a failed run logs + degrades to NO-OP, never throws (no DLQ thrash for a
    // non-critical breadcrumb; a missed week is acceptable).
    console.error('[kg_borrow_shadow_sweep] failed; degrading to NO-OP', err);
    return { ...EMPTY_STATS, noop: true, eventId: null };
  }
}

/**
 * pg-boss handler builder. Self-swallowing (runKgBorrowShadowSweep never throws), so a run
 * failure logs but does not DLQ — matching the "失败自吞 log" DARK-SHIP RESILIENCE contract.
 */
export function buildKgBorrowShadowSweepHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    await runKgBorrowShadowSweep(db);
  };
}
