// Weekly shadow of the dark A5/A6 borrowing layer. Both flags are off, so the live path
// produces no data to decide a flip. This sweep runs the same pure math regardless of
// flags and emits one summary event, without changing live behavior.
//
// The payload attributes the counterfactual three ways: A5 only, A6 only, and joint. It
// also snapshots the constants and component structure so the owner can re-read the
// distribution later. Quantiles use the shared type-7 convention; histogram bounds derive
// from the component cap.
//
// Read-only: the only write is the fold-inert summary event, stamped to opt out of memory
// ingestion. Components over the cap are skipped and their sizes reported. A failed run
// logs and no-ops; a missed week must never crash the worker.

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
import { writeEvent } from '@/kernel/events';
// Shared with the live layer so the shadow cannot drift.
import {
  BORROW_EPS,
  PROJECTION_EDGE_RELATION_TYPES,
  splitProjectionEdgeRows,
} from '@/kernel/read-models/mastery-projection';

export const KG_BORROW_SHADOW_ACTION = 'experimental:kg_borrow_shadow';
export const KG_BORROW_SHADOW_SUBJECT_KIND = 'kg_borrow_shadow';
// Fixed subject id keeps the one-event-per-run breadcrumb query-stable.
export const KG_BORROW_SHADOW_SUBJECT_ID = 'global';

// Must match the live guard, or the shadow would misreport the flip.
export const SHADOW_BORROW_COMPONENT_CAP = GRAPH_SMOOTH_COMPONENT_CAP;

// Warn-only guard for the unchunked global load; the run proceeds.
const SHADOW_SWEEP_SCALE_WARN = 50_000;

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

/** Deterministic quantile summary; uses the shared type-7 convention. */
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

/** Power-of-two buckets up to the cap, plus one overflow bucket. */
export function componentHistogram(sizes: number[], cap: number): Record<string, number> {
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

/** One counterfactual's move/borrow summary. */
export interface VariantStats {
  observed_moved_count: number;
  would_borrow_count: number;
  /** |theta_tilde - theta_hat| over moved observed KCs. */
  delta_theta: QuantileSummary | null;
  /** Borrowed theta_tilde over unobserved KCs. */
  borrowed_theta: QuantileSummary | null;
}

export interface ShadowBorrowStats {
  observed_count: number;
  a5_only: VariantStats;
  a6_only: VariantStats;
  /** A5 smoothing then A6 propagation, matching the live layer's order. */
  joint: VariantStats;
  // Structural A5 quantities, reported once rather than per variant.
  component_count: number;
  component_size_max: number;
  component_size_histogram: Record<string, number>;
  skipped_components: number;
  skipped_component_sizes: number[];
}

/** Count moved observed KCs and would-borrow unobserved ones, plus distributions. */
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
 * Run one shared A5 solve and attribute the effect three ways. The structural gating
 * matches the live layer with flags omitted: no symmetric edges degenerates A5, no
 * directed edges degenerates A6.
 */
export function computeShadowBorrowStats(
  observed: Map<string, ObservedNode>,
  symmetric: SymmetricEdge[],
  directed: DirectedEdge[],
  componentCap: number,
): ShadowBorrowStats {
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

  // One shared dense A5 solve; degenerate without symmetric edges.
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
  // A6 over bare theta for a6_only, over A5 theta for joint.
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
    // Reduce, not spread: a whole-tree partition can exceed the argument limit.
    component_size_max: componentSizes.reduce((m, s) => (s > m ? s : m), 0),
    component_size_histogram: componentHistogram(componentSizes, componentCap),
    skipped_components: skippedComponentSizes.length,
    skipped_component_sizes: [...skippedComponentSizes].sort((a, b) => a - b),
  };
}

export interface KgBorrowShadowReport extends ShadowBorrowStats {
  noop: boolean;
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
  /** Test-only cap override, so a small graph can trip the skip path. */
  componentCap?: number;
}

/**
 * Load live states and edges, compute, and emit one summary event. Empty input is a
 * no-op; any failure logs and no-ops rather than throwing.
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

    // Global live edges, with the same relation set and split as the live projection.
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

    const loadedScale = observedRows.length + edgeRows.length;
    if (loadedScale > SHADOW_SWEEP_SCALE_WARN) {
      console.warn('[kg_borrow_shadow_sweep] global load scale high — no chunking (guardrail)', {
        observedRows: observedRows.length,
        edgeRows: edgeRows.length,
        threshold: SHADOW_SWEEP_SCALE_WARN,
      });
    }

    const stats = computeShadowBorrowStats(observed, symmetric, directed, componentCap);

    const eventId = newId();
    await writeEvent(db, {
      id: eventId,
      actor_kind: 'system',
      actor_ref: 'kg_borrow_shadow_sweep',
      action: KG_BORROW_SHADOW_ACTION,
      subject_kind: KG_BORROW_SHADOW_SUBJECT_KIND,
      subject_id: KG_BORROW_SHADOW_SUBJECT_ID,
      outcome: null,
      payload: {
        ...stats,
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
      // Memory opt-out: internal breadcrumb, not user activity.
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
    // Observability only: no consumer, so a failed week no-ops instead of hitting the DLQ.
    console.error('[kg_borrow_shadow_sweep] failed; degrading to NO-OP', err);
    return { ...EMPTY_STATS, noop: true, eventId: null };
  }
}

/** Self-swallowing, so a failed run logs but never DLQs. */
export function buildKgBorrowShadowSweepHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    await runKgBorrowShadowSweep(db);
  };
}
