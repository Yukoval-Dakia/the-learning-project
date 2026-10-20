// YUK-1570 — canonical mastery p(L) projection read model: the SINGLE
// display/AI-facing read of mastery, plus the A5/A6 KG-borrowing soft layer and
// the representative-KC β resolution it consumes. Moved verbatim from
// src/server/mastery/state.ts; the server module remains the SOLE writer of
// `mastery_state` (ADR-0035) and keeps an explicit compat re-export for current
// tests/external users.

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import {
  GRAPH_LAPLACIAN_ENABLED,
  GRAPH_LAPLACIAN_KAPPA,
  GRAPH_LAPLACIAN_LAMBDA,
  GRAPH_SMOOTH_COMPONENT_CAP,
  type SymmetricEdge,
  smoothThetaByComponent,
} from '@/core/graph-laplacian';
import { PFA_GAMMA, PFA_RHO, pLearnedBand, pfaLogit } from '@/core/pfa';
import {
  type DirectedEdge,
  PREREQ_PROP_LAMBDA_DOWN,
  PREREQ_PROP_LAMBDA_UP,
  PREREQ_THETA_PROPAGATION_ENABLED,
  propagatePrereq,
} from '@/core/prereq-propagation';
import { thetaSe } from '@/core/theta';
import type { Db, Tx } from '@/db/client';
import { knowledge_edge, mastery_state } from '@/db/schema';

type DbLike = Db | Tx;

/**
 * B1 double-truth fix — the SINGLE display/AI-facing read of mastery, derived
 * from the real `mastery_state` source of truth (NOT the deprecated
 * `knowledge_mastery` view's faked recency-weighted-success-rate +
 * `evidence_count < 3 → 0.5` placeholder).
 *
 * Batch read of the p(L) state for many knowledge nodes, projecting each row to
 * a 0..1 `mastery` via the **difficulty-aware PFA p(L)** ({@link pLearnedBand} /
 * {@link pfaLogit}: logit = γ·success + ρ·fail − β, where β is the KC's
 * representative HARD-track item difficulty), and exposing `theta_se` (from
 * `theta_precision`, default precision=1 → SE=1) for uncertainty. Returns a Map
 * keyed by knowledge id. Nodes with no `mastery_state` row (never attempted) are
 * simply ABSENT from the map — callers treat absence as cold start /
 * `mastery=null`, matching the old view's NULL (no-evidence) semantics.
 * `last_outcome_at` is the real last-attempt time (replaces the view's
 * `last_evidence_at`).
 *
 * B1 FULL path (YUK-420) — this is the LIVE difficulty-aware p(L) projection,
 *   completing the path that previously shipped only the interim σ(θ̂)@b=0
 *   point estimate:
 *     - `mastery` = p(L) point estimate = σ(γ·success + ρ·fail − β). Cold start
 *       (success=0, fail=0, β=0) → 0.5. Harder KC (larger β) lowers p(L) at fixed
 *       counts; more successes raise it; more failures lower it.
 *     - `mastery_lo` / `mastery_hi` = the ADR-0035 confidence-interval band
 *       (point logit ± theta_se, each through σ). Widens as θ̂ uncertainty grows.
 *     - `low_confidence` = true when θ̂ is still too uncertain to trust the point
 *       (theta_se ≥ the precision threshold) — presentation should show the band.
 *   `theta_hat` / `theta_precision` / `theta_se` are surfaced raw so callers keep
 *   the underlying ability state. The PFA γ/ρ coefficients are owner-fixed,
 *   code-reviewed module consts (cross-learner structural coefficients, same footing
 *   as ELO_K_GLOBAL / DIFFICULTY_PROXY_WEIGHT) — no PFA refit job exists or runs for
 *   them; recalibration_nightly refits only item difficulty b. See src/core/pfa.ts
 *   for the full rationale + retune IOU.
 *
 *   The CI fields are ADDITIVE — the 5 point-estimate consumers (tree / node-page
 *   / knowledge-readers / detail) read only `mastery` and are
 *   transparent to the swap; the new fields are opt-in for CI-aware surfaces.
 */
/**
 * YUK-559 (S1) — read-model provenance discriminant for a {@link MasteryProjection}
 * entry. `'observed'` = derived from the KC's own `mastery_state` row (count-driven
 * p(L) band). `'inferred'` = a KG-borrowed entry synthesised for a requested-but-
 * unobserved KC by the A5/A6 soft layer (dark). It is a READ-MODEL field only — it is
 * NEVER persisted into `mastery_state` (adding a column would pollute the three-axis
 * calibration orthogonality, ADR-0035). Consumers gate borrow-aware behaviour on this
 * plus `evidence_count`; see {@link isObserved}.
 */
export type MasteryProvenance = 'observed' | 'inferred';

export interface MasteryProjection {
  mastery: number;
  // B1 FULL (YUK-420) — ADR-0035 confidence-interval band around the p(L) point.
  // Additive: existing consumers ignore these; CI-aware surfaces show the band.
  mastery_lo: number;
  mastery_hi: number;
  low_confidence: boolean;
  theta_hat: number;
  theta_precision: number;
  theta_se: number;
  evidence_count: number;
  success_count: number;
  fail_count: number;
  last_outcome_at: Date | null;
  /** YUK-495 #41 — the representative β anchor fed to pfaLogit, exposed so the client can
   *  re-derive the band bit-for-bit from raw evidence (success/fail/β/precision). */
  beta: number;
  /** YUK-559 (S1) — provenance discriminant (read model). 'observed' for a KC's own
   *  mastery_state row; 'inferred' for a KG-borrowed synthesized entry. Never persisted. */
  provenance: MasteryProvenance;
  /** YUK-559 (S1) — the pre-smoothing RAW θ̂ of an OBSERVED KC whose surfaced `theta_hat`
   *  was moved in place by the A5/A6 soft layer (applyKgSoftLayer). Present ONLY when the
   *  layer actually moved this observed KC's mean (flag ON AND θ̃ ≠ θ̂) — ABSENT on the
   *  flag-off path and for KCs the layer left untouched, so a neighbour-dominated weak
   *  observation (low precision, mean pulled by neighbours) stays inspectable behind the
   *  binary provenance flag. Read model only — never persisted. */
  theta_hat_raw?: number;
}

/**
 * YUK-559 (S1) — the provenance discriminant helper. True iff the projection entry is
 * derived from the KC's own `mastery_state` evidence (NOT a KG-borrowed inferred entry).
 * Consumers that must not treat a borrowed θ̃ as measured mastery gate on this.
 */
export function isObserved(p: Pick<MasteryProjection, 'provenance'>): boolean {
  return p.provenance === 'observed';
}

/**
 * YUK-559 (S1 / C9) — the LIVE knowledge_edge relation_type set the A5/A6 soft layer
 * borrows from: `related_to` (A5 symmetric), `prerequisite` + `derived_from` (A6 directed).
 * `contrasts_with` is deliberately absent (reverse signal → poisons firm-up). SINGLE SOURCE —
 * both the live projection load ({@link loadEdgesForProjection}) and the shadow sweep
 * (`kg_borrow_shadow_sweep`) consume this so their admitted relation set can never drift apart.
 */
export const PROJECTION_EDGE_RELATION_TYPES = [
  'related_to',
  'prerequisite',
  'derived_from',
] as const;

/**
 * YUK-559 (S1 / C9) — the borrow epsilon: a |θ̃ − θ̂| at or below this is treated as "no move"
 * (float noise, not a real borrow). SINGLE SOURCE shared by the live soft layer
 * ({@link applyKgSoftLayer}) and the shadow sweep so their move/borrow thresholds can't diverge.
 */
export const BORROW_EPS = 1e-9;

/** A raw typed knowledge_edge row feeding the borrow projection split. */
export interface ProjectionEdgeRow {
  from_id: string;
  to_id: string;
  relation_type: string;
  weight: number;
}

/**
 * YUK-559 (S1 / C9) — split + orientation-normalise live typed knowledge_edge rows into the
 * A5 symmetric / A6 directed edge lists. PURE code motion (extracted verbatim from
 * {@link loadEdgesForProjection} so the live path stays bit-equivalent):
 *   - `related_to`  → {@link SymmetricEdge} {a: from, b: to} (A5, undirected smoothing).
 *   - `prerequisite` → {@link DirectedEdge} {from: prereq, to: dependent} (A6, prereq→dependent).
 *   - `derived_from` → {@link DirectedEdge} {from: to (base), to: from (derived)} — orientation
 *     FLIPPED vs prerequisite ("from 派生自 to" ⇒ base `to` is the prereq-like node, ADR-0010).
 * Any other relation_type is dropped. Both the live load and the shadow sweep consume this ⇒
 * their split logic can never drift apart. Pure.
 */
export function splitProjectionEdgeRows(rows: ProjectionEdgeRow[]): {
  symmetric: SymmetricEdge[];
  directed: DirectedEdge[];
} {
  const symmetric: SymmetricEdge[] = [];
  const directed: DirectedEdge[] = [];
  for (const r of rows) {
    if (r.relation_type === 'related_to') {
      symmetric.push({ a: r.from_id, b: r.to_id, weight: r.weight });
    } else if (r.relation_type === 'prerequisite') {
      directed.push({ from: r.from_id, to: r.to_id, weight: r.weight });
    } else if (r.relation_type === 'derived_from') {
      directed.push({ from: r.to_id, to: r.from_id, weight: r.weight });
    }
  }
  return { symmetric, directed };
}

export async function getMasteryProjection(
  // Read inside activation as well as display requests, so progress telemetry
  // observes this occurrence before any later settlements are replayed.
  db: DbLike,
  knowledgeIds: string[],
  subjectKind = 'knowledge',
): Promise<Map<string, MasteryProjection>> {
  const ids = Array.from(
    new Set(knowledgeIds.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(mastery_state)
    .where(
      and(eq(mastery_state.subject_kind, subjectKind), inArray(mastery_state.subject_id, ids)),
    );
  // B1 FULL (YUK-420) — per-KC representative β = the KC's HARD-track item
  // difficulty (logit). β feeds the difficulty-aware p(L) (harder KC ⇒ lower p(L)
  // at fixed counts). KCs with no anchored hard-track item → β=0 (neutral
  // difficulty origin), so cold-start / unanchored KCs project exactly as before
  // (σ at b=0). Only KCs that HAVE a mastery_state row need a β (others are absent
  // from the map), so we resolve β only for the rows we actually project.
  const betaByKc = await getRepresentativeKcBeta(
    db,
    rows.map((r) => r.subject_id),
  );
  const projection = new Map<string, MasteryProjection>(
    rows.map((row) => {
      const beta = betaByKc.get(row.subject_id) ?? 0;
      const se = thetaSe(row.theta_precision);
      // logit(p(L)) = γ·success + ρ·fail − β (ADR-0035 sign convention; β enters
      // negatively so harder items lower p(L) — see src/core/pfa.ts).
      const pointLogit = pfaLogit(beta, PFA_GAMMA, PFA_RHO, row.success_count, row.fail_count);
      // CI band on the logit scale ± theta_se, each through σ (ADR-0035
      // confidence-interval / low-confidence presentation).
      const band = pLearnedBand(pointLogit, se);
      return [
        row.subject_id,
        {
          mastery: band.point,
          mastery_lo: band.lo,
          mastery_hi: band.hi,
          low_confidence: band.lowConfidence,
          theta_hat: row.theta_hat,
          theta_precision: row.theta_precision,
          theta_se: se,
          evidence_count: row.evidence_count,
          success_count: row.success_count,
          fail_count: row.fail_count,
          last_outcome_at: row.last_outcome_at ?? null,
          beta,
          // YUK-559 (S1) — this entry IS the KC's own mastery_state evidence.
          provenance: 'observed',
        },
      ];
    }),
  );

  // ── A5/A6 (YUK-441 / YUK-442) — KG-borrowing soft layer over the surfaced θ̂ ─────
  //
  // FLAG OFF (DEFAULT, dark-ship): BOTH GRAPH_LAPLACIAN_ENABLED and
  //   PREREQ_THETA_PROPAGATION_ENABLED are false → this block is skipped ENTIRELY → no edge
  //   fetch, no neighbour read, no borrowed entries. The `projection` map above is
  //   returned BYTE-IDENTICAL to today (the regression anchor the db tests pin).
  // SCOPE: only the per-KC 'knowledge' axis carries a knowledge graph. The A2
  //   'ability_global' subjectKind has no knowledge_edge adjacency → skipped (its
  //   projection is returned unchanged). Empty id set short-circuits above.
  // The act flip (set either flag true) is gated on V-A5-LOKO (A5) / the A6 validation
  //   gate — built + electrified to live now, flip deferred (defer-flip, not -build).
  if (
    (GRAPH_LAPLACIAN_ENABLED || PREREQ_THETA_PROPAGATION_ENABLED) &&
    subjectKind === 'knowledge' &&
    ids.length > 0
  ) {
    await applyKgSoftLayer(db, ids, rows, projection);
  }

  return projection;
}

/**
 * The A5/A6 KG-borrowing soft layer (math dossier 2026-06-20). MEAN-ONLY: it rewrites
 * ONLY the surfaced `theta_hat` (the per-KC ability posterior mean) of the requested
 * KCs and APPENDS borrowed entries for requested-but-unobserved KCs that borrow a θ̃
 * from observed neighbours. It NEVER touches `theta_se` / `theta_precision` / the p(L)
 * `mastery` band of observed KCs (ADR-0035 corollary — the graph-shrunk variance is
 * not trusted as calibrated until V-A5-LOKO, so it is not surfaced; observed KCs keep
 * their own count-driven p(L) band). It NEVER writes mastery_state (read-side recompute
 * → edges stay revisable; the三维正交 calibration axis is not polluted).
 *
 * INFLUENCE RADIUS (YUK-559 / RP8): A5 is NOT 1-hop. `loadEdgesForProjection` bounds the
 * LOADED edge set (incident-to-requested), NOT the influence radius — the GMRF joint solve
 * couples the whole requested-induced `related_to` connected component (a whole-tree read
 * couples the whole tree). To bound the dense-solve cost, A5 solves per connected component
 * and skips any component over GRAPH_SMOOTH_COMPONENT_CAP (see smoothThetaByComponent). A6
 * (directed) IS a true single-pass 1-hop Δθ. All flag-dark today.
 *
 * Mutates `projection` in place (the caller's map). Flag-gated by the caller; this fn
 * runs only when at least one of A5/A6 is enabled.
 */
async function applyKgSoftLayer(
  db: DbLike,
  requestedIds: string[],
  observedRows: Array<typeof mastery_state.$inferSelect>,
  projection: Map<string, MasteryProjection>,
): Promise<void> {
  // 1. Load adjacent typed edges (archived_at IS NULL — ADR-0034 soft-archive).
  //    A5 admits ONLY symmetric `related_to`; A6 admits directed `prerequisite` /
  //    `derived_from` (normalised to prereq→dependent). `contrasts_with` enters NEITHER.
  const { symmetric, directed } = await loadEdgesForProjection(db, requestedIds);
  if (symmetric.length === 0 && directed.length === 0) return; // no KG adjacency → no-op.

  // 2. Build the node set = requested ∪ edge endpoints. Fetch θ̂ for any neighbour KC
  //    not already among the requested-observed rows (observed neighbours supply the
  //    data the unobserved nodes borrow from; unobserved neighbours stay latent dₖ=0).
  const observedById = new Map(observedRows.map((r) => [r.subject_id, r]));
  const nodeIdSet = new Set<string>(requestedIds);
  for (const e of symmetric) {
    nodeIdSet.add(e.a);
    nodeIdSet.add(e.b);
  }
  for (const e of directed) {
    nodeIdSet.add(e.from);
    nodeIdSet.add(e.to);
  }
  const extraNeighbourIds = [...nodeIdSet].filter((id) => !observedById.has(id));
  const neighbourRows =
    extraNeighbourIds.length > 0
      ? await db
          .select()
          .from(mastery_state)
          .where(
            and(
              eq(mastery_state.subject_kind, 'knowledge'),
              inArray(mastery_state.subject_id, extraNeighbourIds),
            ),
          )
      : [];

  // θ̂ + observation-precision over the whole node set. A node with a row is OBSERVED
  // (dₖ = its Fisher precision → strong evidence sticks to θ̂); absent = latent (dₖ=0).
  const nodeIds = [...nodeIdSet];
  const thetaHat = new Map<string, number>();
  const observationPrecision = new Map<string, number>();
  for (const r of [...observedRows, ...neighbourRows]) {
    thetaHat.set(r.subject_id, r.theta_hat);
    observationPrecision.set(r.subject_id, r.theta_precision);
  }

  // 3. A5 first (symmetric smoothing), then A6 (directed order prior) on the smoothed
  //    estimates. Each flag is independent; flag-off leg is a structural pass-through.
  let thetaTilde = thetaHat;
  if (GRAPH_LAPLACIAN_ENABLED && symmetric.length > 0) {
    // YUK-559 (S4 / RP8) — component-chunked solve. The GMRF precision is block-diagonal
    // across related_to connected components, so solving each independently is EXACT
    // (ΣO(nᵢ³) ≤ O(n³), a pure equivalent rearrangement). A component larger than
    // GRAPH_SMOOTH_COMPONENT_CAP is left UN-smoothed (fail-safe-to-no-smoothing) so the
    // request-shaped O(n³) dense-solve cliff never runs on a whole-tree component.
    const smoothed = smoothThetaByComponent(
      nodeIds,
      symmetric,
      thetaHat,
      observationPrecision,
      GRAPH_LAPLACIAN_LAMBDA,
      GRAPH_LAPLACIAN_KAPPA,
      GRAPH_SMOOTH_COMPONENT_CAP,
    );
    thetaTilde = smoothed.theta;
    if (smoothed.skippedComponentSizes.length > 0) {
      // Single structured warn (mirror learnable-frontier overflow warn form): a related_to
      // component exceeded the conservative cap → smoothing skipped for it (raw θ̂ passthrough).
      console.warn(
        '[kg-borrow] A5 component cap tripped — smoothing skipped for oversized related_to component(s)',
        {
          cap: GRAPH_SMOOTH_COMPONENT_CAP,
          skippedComponentSizes: smoothed.skippedComponentSizes,
          totalComponents: smoothed.componentSizes.length,
          hint: 'a requested set induced a related_to component larger than the cap; those KCs keep raw θ̂ (no smoothing). See docs/design/2026-07-04-kg-borrowing-spec.md RP8.',
        },
      );
    }
  }
  if (PREREQ_THETA_PROPAGATION_ENABLED && directed.length > 0) {
    thetaTilde = propagatePrereq(
      nodeIds,
      thetaTilde,
      directed,
      PREREQ_PROP_LAMBDA_DOWN,
      PREREQ_PROP_LAMBDA_UP,
    );
  }

  // 4. Rewrite the surfaced θ̂ (MEAN ONLY) for requested KCs, and append borrowed
  //    entries for requested-but-unobserved KCs that borrowed a non-trivial θ̃.
  const PRIOR_MEAN = 0;
  // BORROW_EPS is the exported module const (C9 single source, shared with the shadow sweep).
  const borrowedIds: string[] = [];
  for (const id of requestedIds) {
    const tilde = thetaTilde.get(id);
    if (tilde === undefined) continue;
    const existing = projection.get(id);
    if (existing) {
      // Observed KC: move the surfaced ability mean; leave se / precision / p(L) band.
      // YUK-559 (S1) — preserve the pre-move raw θ̂ so a neighbour-dominated weak
      // observation stays inspectable. Only stamp theta_hat_raw when the mean actually
      // moved beyond the shared BORROW_EPS threshold (|θ̃ − θ̂| > BORROW_EPS) — the same
      // "did it move?" test the borrow detection (below) and the shadow sweep use (C9).
      // A strict θ̃ ≠ θ̂ would spuriously stamp on GMRF dense-solve FP noise / a sub-eps κ
      // ridge pull, polluting the raw field for clients that inspect it. An unmoved observed
      // KC keeps the field absent (flag-off never reaches here → absent on the byte-identical path).
      if (Math.abs(tilde - existing.theta_hat) > BORROW_EPS)
        existing.theta_hat_raw = existing.theta_hat;
      existing.theta_hat = tilde;
    } else if (Math.abs(tilde - PRIOR_MEAN) > BORROW_EPS) {
      // Unobserved requested KC that borrowed from observed neighbours → mark for a
      // synthesized low-confidence entry (boundary behaviour change: map gains a row).
      borrowedIds.push(id);
    }
  }

  if (borrowedIds.length > 0) {
    // Resolve β for the borrowed KCs (same representative hard-track median b as the
    // observed path). Cold-start counts (success=fail=0) → mastery = σ(−β). The borrowed
    // estimate is LOW CONFIDENCE: precision stays at the cold default (SE=1 → the
    // low_confidence band) — we move the mean but DO NOT manufacture certainty.
    const borrowedBeta = await getRepresentativeKcBeta(db, borrowedIds);
    const borrowedPrecision = 1; // cold-start default precision (SE = thetaSe(1)).
    const borrowedSe = thetaSe(borrowedPrecision);
    for (const id of borrowedIds) {
      const beta = borrowedBeta.get(id) ?? 0;
      const pointLogit = pfaLogit(beta, PFA_GAMMA, PFA_RHO, 0, 0);
      const band = pLearnedBand(pointLogit, borrowedSe);
      projection.set(id, {
        mastery: band.point,
        mastery_lo: band.lo,
        mastery_hi: band.hi,
        low_confidence: true, // borrowed estimate is never high-confidence.
        theta_hat: thetaTilde.get(id) as number,
        theta_precision: borrowedPrecision,
        theta_se: borrowedSe,
        evidence_count: 0,
        success_count: 0,
        fail_count: 0,
        last_outcome_at: null,
        beta,
        // YUK-559 (S1) — synthesized KG-borrowed entry, NOT this KC's own evidence.
        provenance: 'inferred',
      });
    }
  }
}

/**
 * Load the typed knowledge_edge adjacency feeding the A5/A6 soft layer: any LIVE
 * (archived_at IS NULL) `related_to` / `prerequisite` / `derived_from` edge incident
 * to a requested KC. Returns the edges already split + orientation-normalised:
 *   - `related_to`  → {@link SymmetricEdge} (A5, undirected smoothing).
 *   - `prerequisite` (from --prereq--> to: from IS the prerequisite of to) →
 *     {@link DirectedEdge} {from: prereq, to: dependent}.
 *   - `derived_from` (from 派生自 to, ADR-0010: `to` is the base) → {from: to (base,
 *     prereq-like), to: from (derived, dependent)} — OPPOSITE orientation to prerequisite.
 * `contrasts_with` is deliberately NOT selected (reverse signal → poisons firm-up).
 * Pure SELECT (read-only). Both endpoints filtered against the requested set is NOT
 * applied — we keep edges with one endpoint outside so unobserved requested KCs can
 * borrow from observed neighbours; buildLaplacian drops any edge whose endpoint is not
 * in the final node set.
 */
async function loadEdgesForProjection(
  db: DbLike,
  kcIds: string[],
): Promise<{ symmetric: SymmetricEdge[]; directed: DirectedEdge[] }> {
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
        or(
          inArray(knowledge_edge.from_knowledge_id, kcIds),
          inArray(knowledge_edge.to_knowledge_id, kcIds),
        ),
      ),
    );
  // C9 single source — the split + orientation-normalise lives in splitProjectionEdgeRows
  // (shared with the shadow sweep). A5 symmetric (related_to), A6 directed (prerequisite +
  // orientation-flipped derived_from); contrasts_with is excluded by the relation-type filter.
  return splitProjectionEdgeRows(edgeRows);
}

/**
 * B1 FULL (YUK-420) — resolve a representative HARD-track item difficulty (β, on
 * the logit b-scale) per knowledge node, for the difficulty-aware p(L).
 *
 * Representative-b choice (documented): a KC is carried by MANY questions, each
 * possibly anchored by a HARD-track `item_calibration` row. There is no single
 * "the KC's b"; we summarise across the KC's hard-track items using the **MEDIAN**
 * of each item's effective b = COALESCE(b_calib, b_anchor, b) — the same read
 * order as {@link effectiveB} (de-biased b_calib first, then cold-start anchor
 * b_anchor, then the legacy b column). Median (not mean) is robust to a single
 * mis-anchored outlier item skewing the KC difficulty. SOFT-track rows are
 * EXCLUDED (ADR-0035: soft track never reaches p(L)/scheduling). Items with no
 * effective b at all are skipped; a KC with no anchored hard-track item gets NO
 * entry. `getMasteryProjection` defaults that absence to β=0 for its math, while
 * read models may use map presence as the authoritative has-anchor bit (YUK-528).
 *
 * READ-ONLY — pure SELECT against question.knowledge_ids (GIN @>) ⋈ item_calibration;
 * never writes any b column (item-half locked, G4).
 */
export async function getRepresentativeKcBeta(
  db: DbLike,
  knowledgeIds: string[],
): Promise<Map<string, number>> {
  const ids = Array.from(new Set(knowledgeIds.filter((id) => id.length > 0)));
  if (ids.length === 0) return new Map();
  // For each requested KC, find questions carrying it (knowledge_ids @> '["<kc>"]',
  // hitting the question_knowledge_ids_gin index), join their HARD-track
  // item_calibration, and take the median effective b. unnest(<ids>) drives the
  // per-KC grouping; jsonb_build_array(kc) keeps the GIN containment predicate
  // index-friendly per KC. The id list is parameter-bound (sql.join), not string-
  // interpolated — no injection surface.
  const idParams = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.execute<{ kc: string; beta: number | null }>(sql`
    SELECT
      kc,
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY COALESCE(ic.b_calib, ic.b_anchor, ic.b)
      ) AS beta
    FROM unnest(ARRAY[${idParams}]::text[]) AS kc
    JOIN question q ON q.knowledge_ids @> jsonb_build_array(kc)
    JOIN item_calibration ic ON ic.question_id = q.id
      AND ic.track = 'hard'
      AND COALESCE(ic.b_calib, ic.b_anchor, ic.b) IS NOT NULL
    GROUP BY kc
  `);
  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.beta !== null && r.beta !== undefined) {
      map.set(r.kc, Number(r.beta));
    }
  }
  return map;
}
