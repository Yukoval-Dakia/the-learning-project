// YUK-471 W1 PR-A2a — read-only gather+fold helpers shared by the IO shells and the
// projection auditor.
//
// The IO shells (knowledge.ts / knowledge_edge.ts) and the projection auditor
// (scripts/audit-projection.ts) both need the SAME read→fold step: gather the superset of
// `event` rows that can affect a node/edge id, map each → FoldEvent, and run the PURE
// reducer. The only difference is what they do with the result — the shell WRITES it through
// (insert/onConflictDoUpdate or DELETE); the auditor DEEP-DIFFS it against the live row in
// memory and writes NOTHING. Factoring the read→fold half out keeps a SINGLE gather
// implementation, so the SoT path (shell) and the drift auditor can never silently diverge
// in HOW they reconstruct a row (a divergence would make the audit blind to exactly the
// gather bugs it exists to catch).
//
// These functions are READ-ONLY: they SELECT from `event` / `knowledge_edge` /
// `materialized_id_index` and return the projected snapshot (or null). They never write.
//
// BEHAVIOR-PRESERVING (PR-A2a): added + used by the (un-wired) shells + the standalone
// auditor only; no live write path imports them.

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';

import { foldArtifact } from '@/core/projections/artifact';
import type { FoldEvent } from '@/core/projections/fold-event';
import { foldGoal } from '@/core/projections/goal';
import { foldKnowledgeNode } from '@/core/projections/knowledge';
import { foldKnowledgeEdge } from '@/core/projections/knowledge_edge';
import { foldLearningItem } from '@/core/projections/learning_item';
import { foldMistakeVariant } from '@/core/projections/mistake_variant';
import { foldQuestionBlock } from '@/core/projections/question_block';
import type {
  ArtifactRowSnapshotT,
  GoalRowSnapshotT,
  KnowledgeEdgeRowSnapshotT,
  KnowledgeRowSnapshotT,
  LearningItemRowSnapshotT,
  MistakeVariantRowSnapshotT,
  QuestionBlockRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { getAnchorEventId } from './materialized-id-index';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
type EdgeRow = typeof knowledge_edge.$inferSelect;

// rowToFoldEvent — map ONE `event` DB row to the flat FoldEvent envelope the reducers
// consume. payload is jsonb; outcome / caused_by_event_id may be null. (Shared by both
// node + edge gathers; identical to the per-shell mapper they previously each declared.)
export function rowToFoldEvent(row: EventRow): FoldEvent {
  return {
    id: row.id,
    created_at: row.created_at,
    actor_kind: row.actor_kind,
    actor_ref: row.actor_ref,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    outcome: row.outcome ?? null,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    caused_by_event_id: row.caused_by_event_id ?? null,
  };
}

// edgeRowToSnapshot — map a live `knowledge_edge` DB row to the KnowledgeEdgeRowSnapshotT
// shape the edge fold produces. EXPORTED as the single definition shared by (a) this gather's
// liveMesh topology fixture and (b) the accept-time edge parity assert (actions.ts): parity
// must compare the SAME shape the fold builds, so both sides map through THIS function — a
// second copy could drift and make the assert compare mismatched shapes.
export function edgeRowToSnapshot(row: EdgeRow): KnowledgeEdgeRowSnapshotT {
  return {
    id: row.id,
    from_knowledge_id: row.from_knowledge_id,
    to_knowledge_id: row.to_knowledge_id,
    relation_type: row.relation_type,
    weight: row.weight,
    created_by: row.created_by as Record<string, unknown>,
    reasoning: row.reasoning ?? null,
    created_at: row.created_at,
    archived_at: row.archived_at ?? null,
  };
}

/**
 * Prefetch the node-INDEPENDENT merge-event superset the node fold's Q3 leg consumes: EVERY
 * `experimental:knowledge_merge` propose event. READ-ONLY. The containment filter to ONE node
 * (`payload.from_ids @> [nodeId]`) is applied IN MEMORY by the caller (gatherAndFoldKnowledgeNode).
 *
 * YUK-549 (K6) — mirrors prefetchLearningItemMergeEvents. A full-table auditor that folds N nodes
 * would otherwise re-run the per-node Q3 containment scan N times; fetch the (rare) merge events ONCE
 * and thread them in.
 */
export async function prefetchKnowledgeMergeEvents(db: DbLike): Promise<EventRow[]> {
  return db.select().from(event).where(eq(event.action, 'experimental:knowledge_merge'));
}

/**
 * Prefetch the node-INDEPENDENT `rate` superset the node fold's rate-resolution leg consumes: EVERY
 * `rate` event. READ-ONLY. The per-node caused_by chain (rate.caused_by_event_id ∈ this node's
 * gathered propose/merge event ids) is applied IN MEMORY by the caller.
 *
 * YUK-549 (K6) — the un-prefetched path issues one `rate WHERE caused_by IN (gatheredIds)` query per
 * node, so a full-table auditor folding N nodes runs N such queries. Fetch the rate events ONCE and
 * thread them in; the caller filters by the per-node gathered id set, so `byId` ends up identical to
 * the per-node query path (equivalence tested in gather.db.test.ts).
 */
export async function prefetchKnowledgeRates(db: DbLike): Promise<EventRow[]> {
  return db.select().from(event).where(eq(event.action, 'rate'));
}

// In-memory equivalent of the Q3 SQL containment `payload -> 'from_ids' @> [nodeId]`: does this merge
// event's payload.from_ids array contain nodeId. Used to filter a prefetched merge superset per node
// so the threaded path reproduces the per-node containment query EXACTLY (empty/absent from_ids → no
// match, mirroring `@>` returning NULL → false).
function mergeArchivesNode(row: EventRow, nodeId: string): boolean {
  const fromIds = (row.payload as { from_ids?: unknown } | null)?.from_ids;
  return Array.isArray(fromIds) && fromIds.includes(nodeId);
}

/**
 * Gather the superset of events affecting `nodeId` and run the PURE node fold. READ-ONLY.
 *
 * The gather is the keystone of the node projection (see the long rationale on the node
 * shell): Q1 (subject-keyed) + Q2 (reverse-index anchor for propose_new / split CREATE) +
 * Q3 (nodeId merged INTO another node) + the chained accept rates. Returns the projected
 * row or null (node never created / fully reverted). Writes NOTHING — the caller decides
 * (shell write-through vs auditor diff).
 *
 * YUK-549 (K6) — a full-table caller (the auditor) prefetches the item-INDEPENDENT Q3 merge leg and
 * the rate leg ONCE (prefetchKnowledgeMergeEvents / prefetchKnowledgeRates) and threads them in via
 * `prefetchedMergeEvents` / `prefetchedRates`; a single-node caller (the write-through shell,
 * accept-time parity) passes nothing and each leg self-fetches here. Either way `byId` ends up with
 * the identical row set (mirrors the learning_item prefetch, YUK-547).
 */
export async function gatherAndFoldKnowledgeNode(
  db: DbLike,
  nodeId: string,
  prefetchedMergeEvents?: EventRow[],
  prefetchedRates?: EventRow[],
): Promise<KnowledgeRowSnapshotT | null> {
  // ── Q1: events whose subject_id IS nodeId ──────────────────────────────────────────
  // Covers genesis, auto_tag, reparent, archive, merge-as-into, split-as-from.
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'knowledge'), eq(event.subject_id, nodeId)));

  // ── Q2: reverse-index anchor (propose_new / split CREATE) ───────────────────────────
  // For a node born via propose_new / split, no event has subject_id === nodeId. The anchor
  // is the propose/split event the accept materialized this id from; pull the anchor PLUS
  // everything caused_by it (the anchor's accepting rate carries materialized_ids).
  const anchorId = await getAnchorEventId(db, nodeId);
  const q2: EventRow[] = anchorId
    ? await db
        .select()
        .from(event)
        .where(or(eq(event.id, anchorId), eq(event.caused_by_event_id, anchorId)))
    : [];

  // ── Q3: nodeId archived because it was merged INTO another node ──────────────────────
  // The merge event's subject_id is the into_id, NOT nodeId; nodeId lives only in
  // payload.from_ids. jsonb containment: payload -> 'from_ids' @> [nodeId]. A prefetched superset
  // (YUK-549) is filtered in memory to the SAME rows the containment query returns.
  const q3 = prefetchedMergeEvents
    ? prefetchedMergeEvents.filter((r) => mergeArchivesNode(r, nodeId))
    : await db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:knowledge_merge'),
            sql`${event.payload} -> 'from_ids' @> ${JSON.stringify([nodeId])}::jsonb`,
          ),
        );

  // Dedup the propose/mutation/genesis rows by event id (Q1/Q2/Q3 overlap).
  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...q2, ...q3]) byId.set(r.id, r);

  // ── Rate resolution ─────────────────────────────────────────────────────────────────
  // The reducer needs the RATE events chained to the gathered propose/mutation events. A prefetched
  // superset (YUK-549) is filtered in memory by the gathered id set — identical to the caused_by query.
  const gatheredIds = [...byId.keys()];
  if (gatheredIds.length > 0) {
    const gatheredSet = new Set(gatheredIds);
    const rates = prefetchedRates
      ? prefetchedRates.filter(
          (r) => r.caused_by_event_id !== null && gatheredSet.has(r.caused_by_event_id),
        )
      : await db
          .select()
          .from(event)
          .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, gatheredIds)));
    for (const r of rates) byId.set(r.id, r);
  }

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldKnowledgeNode(nodeId, foldEvents);
}

/**
 * Gather the superset of events affecting `goalId` and run the PURE goal fold. READ-ONLY.
 * (YUK-471 Wave 2.)
 *
 * The goal gather is SIMPLER than the node gather (design §1④): goal ids are never minted into
 * a rate's materialized_ids — goalId == the goal_scope proposal's subject_id (target.subject_id
 * reserved by runGoalScopeAndWrite) — so there is NO Q2 reverse-index indirection and NO Q3
 * merged-into. Just Q1 (subject_kind='goal' AND subject_id=goalId: genesis + the
 * experimental:proposal + the W2 status/scope action events) + the caused_by chain (the accept
 * `rate` and the retract `correct`, both subject_kind='event', caused_by = the propose id).
 * Returns the projected row or null. Writes NOTHING.
 */
export async function gatherAndFoldGoal(
  db: DbLike,
  goalId: string,
): Promise<GoalRowSnapshotT | null> {
  // ── Q1: events whose subject_id IS goalId (subject_kind='goal') ─────────────────────────
  // Covers the experimental:proposal (goal_scope), genesis, and the W2 goal_status_update /
  // goal_scope_update action events.
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'goal'), eq(event.subject_id, goalId)));

  // ── caused_by chain: the accept rate + retract correct ──────────────────────────────────
  // The accept `rate` and the proposal-level retract `correct` have subject_kind='event'
  // (subject = the proposal), so Q1 misses them; they are chained to the proposal via
  // caused_by_event_id. Pull every rate/correct caused_by any of the Q1 (proposal) ids.
  const gatheredIds = q1.map((r) => r.id);
  const byId = new Map<string, EventRow>();
  for (const r of q1) byId.set(r.id, r);
  if (gatheredIds.length > 0) {
    const chained = await db
      .select()
      .from(event)
      .where(
        and(
          inArray(event.action, ['rate', 'correct']),
          inArray(event.caused_by_event_id, gatheredIds),
        ),
      );
    for (const r of chained) byId.set(r.id, r);
  }

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldGoal(goalId, foldEvents);
}

/**
 * Gather the superset of events affecting `mvId` and run the PURE mistake_variant fold. READ-ONLY.
 * (YUK-471 Wave 2 — the HARDEST W2 entity, cause_category is fold-blind.)
 *
 * TWO-STEP (design §2④, A4-adjusted): the lifecycle events (accept rate / verify / dismiss rate /
 * retract correct) are chained to the variant_question PROPOSAL, not the mistake_variant row, so
 * we must first learn the proposal id. Step 1 (Q1): subject_kind='mistake_variant' AND
 * subject_id=mvId → the BASE event (experimental:mistake_variant_create at runtime, OR
 * experimental:genesis at backfill — BOTH carry proposal_event_id in payload.row). Step 2: the
 * caused_by chain WHERE caused_by_event_id = <proposal_event_id from the base> AND action IN
 * ('rate','correct','experimental:variant_verify'). NO Q2 reverse index (mvId == the createId()-
 * preallocated subject_id) and NO Q3 merge-into. Returns the projected row or null. Writes NOTHING.
 */
export async function gatherAndFoldMistakeVariant(
  db: DbLike,
  mvId: string,
): Promise<MistakeVariantRowSnapshotT | null> {
  // ── Step 1 (Q1): the base event (create or genesis) keyed on the mistake_variant id ──────────
  const baseRows = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'mistake_variant'), eq(event.subject_id, mvId)));

  const byId = new Map<string, EventRow>();
  for (const r of baseRows) byId.set(r.id, r);

  // Read the proposal_event_id off the base snapshot (create/genesis payload.row). Without a base
  // there is no row to fold (mvId never created) — return null without a second query.
  const proposalIds = new Set<string>();
  for (const r of baseRows) {
    if (r.action !== 'experimental:mistake_variant_create' && r.action !== 'experimental:genesis') {
      continue;
    }
    const payloadRow = (r.payload as { row?: { proposal_event_id?: unknown } } | null)?.row;
    const pid = payloadRow?.proposal_event_id;
    if (typeof pid === 'string' && pid.length > 0) proposalIds.add(pid);
  }

  // ── Step 2: the caused_by chain (accept/dismiss rate, verify, retract correct) ───────────────
  if (proposalIds.size > 0) {
    const chained = await db
      .select()
      .from(event)
      .where(
        and(
          inArray(event.action, ['rate', 'correct', 'experimental:variant_verify']),
          inArray(event.caused_by_event_id, [...proposalIds]),
        ),
      );
    for (const r of chained) byId.set(r.id, r);
  }

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldMistakeVariant(mvId, foldEvents);
}

/**
 * Prefetch the item-INDEPENDENT merge-event superset the learning_item fold's Q3 leg (YUK-543)
 * consumes: EVERY `experimental:knowledge_merge` propose event PLUS the accept `rate` events chained
 * to them. READ-ONLY.
 *
 * YUK-547 — this pair of full-table SELECTs does NOT depend on itemId (the same merges + rates apply
 * to every item), so a full-table audit that folds N items would re-run them N times (O(N × full
 * table)). Fetch it ONCE and thread the result into each `gatherAndFoldLearningItem` call via
 * `prefetchedMergeEvents` (O(full table + N)). Returns the union of merge propose events + their
 * accept rates — the exact rows the un-prefetched path adds to `byId` beyond Q1, so the two paths
 * fold identically (equivalence tested in gather.db.test.ts).
 */
export async function prefetchLearningItemMergeEvents(db: DbLike): Promise<EventRow[]> {
  // Q3 (YUK-543): every knowledge_merge propose event (chain-safe; see the doc on the fold below).
  const merges = await db
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:knowledge_merge'));
  if (merges.length === 0) return [];
  // accept rates chained to the merge propose events (the reducer gates the rewrite on acceptance).
  const mergeIds = merges.map((r) => r.id);
  const rates = await db
    .select()
    .from(event)
    .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, mergeIds)));
  return [...merges, ...rates];
}

/**
 * Gather the superset of events affecting `itemId` and run the PURE learning_item fold. READ-ONLY.
 * (YUK-471 Wave 2.)
 *
 * The learning_item gather is Q1 (subject-keyed status/genesis events) PLUS a merge Q3 (YUK-543):
 *   - Q1 (subject_kind='learning_item' AND subject_id=itemId): genesis + the W2
 *     complete/relearn/archive events. Each keys on the item's OWN id (the recommended route writes
 *     dedicated subject-keyed action events). NO Q2 reverse index (itemId == genesis subject_id).
 *   - Q3 (YUK-543): an accepted `experimental:knowledge_merge` rewrites this item's knowledge_ids
 *     from the absorbed from_id to the survivor into_id. That merge propose event's subject is the
 *     SURVIVOR knowledge node, NOT this item, so Q1 misses it. Unlike the node fold's Q3
 *     (containment-scoped on `payload->'from_ids' @> [nodeId]`), we gather EVERY knowledge_merge
 *     event: merges CHAIN (A→B then B→C), so scoping by the item's seed KCs alone would miss a
 *     second-hop merge whose from_ids no longer contain the seed id — breaking fold==row for
 *     chains. The PURE reducer applies only the intersecting merges (in created_at order — a no-op
 *     for non-touching merges), so the unscoped fetch is correct + chain-safe; merges are rare in a
 *     single-user tool so the fetch is cheap (spec §2 / decision ledger). YUK-547: full-table
 *     callers prefetch this leg once (prefetchLearningItemMergeEvents above) and thread it in.
 *   - accept-rate chain: the reducer only rewrites on an ACCEPTED merge, so pull the `rate` events
 *     chained (caused_by_event_id) to the gathered merge propose events.
 * Returns the projected row or null. Writes NOTHING.
 */
export async function gatherAndFoldLearningItem(
  db: DbLike,
  itemId: string,
  prefetchedMergeEvents?: EventRow[],
): Promise<LearningItemRowSnapshotT | null> {
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'learning_item'), eq(event.subject_id, itemId)));

  // Q3 (YUK-543) + accept-rate chain: item-INDEPENDENT merge events. A full-table caller (the
  // auditor) prefetches them ONCE (YUK-547) and threads them in; a single-item caller passes nothing
  // and this fetches the same superset here. Either way `byId` ends up with the identical row set.
  const mergeEvents = prefetchedMergeEvents ?? (await prefetchLearningItemMergeEvents(db));

  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...mergeEvents]) byId.set(r.id, r);

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldLearningItem(itemId, foldEvents);
}

/**
 * Gather the superset of events affecting `artifactId` and run the PURE artifact fold. READ-ONLY.
 * (YUK-471 Wave 3 — hoisted from the W3-B1 IO shell in C2 so the projection auditor reconstructs
 * the row IDENTICALLY to the shell.)
 *
 * The artifact gather is the SIMPLEST of the epic (design §5.3): EVERY artifact event
 * (genesis / artifact_create / body_blocks_edit / artifact_lifecycle / note_refine_apply /
 * note_refine_undo) keys on the artifact's OWN id, so it is Q1 ONLY (subject_kind='artifact' AND
 * subject_id=artifactId). NO Q2 reverse index (artifactId == the create event's subject_id — no
 * minting indirection; artifact's materialized_id_index entry is the anchor-CHECK leg, not a gather
 * path), NO Q3 merged-into, NO rate caused_by chain (create/edit/lifecycle are direct, not
 * propose→accept). Returns the projected row or null (artifact never created / fully reverted).
 * Writes NOTHING.
 */
export async function gatherAndFoldArtifact(
  db: DbLike,
  artifactId: string,
): Promise<ArtifactRowSnapshotT | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'artifact'), eq(event.subject_id, artifactId)));
  const foldEvents = rows.map(rowToFoldEvent);
  return foldArtifact(artifactId, foldEvents);
}

/**
 * Gather the superset of events affecting `blockId` and run the PURE question_block fold. READ-ONLY.
 * (YUK-471 Wave 3 — hoisted from the W3-B2 IO shell in C2 so the projection auditor reconstructs the
 * row IDENTICALLY to the shell.)
 *
 * A TWO-QUERY merge gather (design §5.2, mirrors the W1 node merge Q3):
 *   - Q1: subject_kind='question_block' AND subject_id=blockId → genesis + question_block_create +
 *     edit-as-primary (every event keyed on blockId's OWN id).
 *   - Q2: the merge reverse query — an edit event is keyed on the PRIMARY block, so when blockId is
 *     an absorbed `merged_source` the event's subject_id is a DIFFERENT block and Q1 misses it.
 *     blockId lives only in payload.affected_blocks[].block_id; the TOP-LEVEL `event.payload @>
 *     {affected_blocks:[{block_id}]}` jsonb-containment finds it. This top-level `@>` form is the
 *     shape the W3-C0 `event_payload_idx` GIN (jsonb_path_ops on the whole `payload` column)
 *     accelerates — the sub-extraction form (`payload->'affected_blocks' @> …`) would NOT hit it
 *     (C0 finding). Mirrors gatherAndFoldKnowledgeNode's Q3 containment.
 *
 * Returns the projected row or null (block never created). Writes NOTHING.
 */
export async function gatherAndFoldQuestionBlock(
  db: DbLike,
  blockId: string,
): Promise<QuestionBlockRowSnapshotT | null> {
  // ── Q1: events whose subject_id IS blockId ──────────────────────────────────────────────────
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'question_block'), eq(event.subject_id, blockId)));

  // ── Q2: edit events that ABSORB blockId as a merged_source (keyed on a DIFFERENT primary) ─────
  // Top-level `@>` containment (hits the W3-C0 event_payload_idx GIN, jsonb_path_ops).
  const q2 = await db
    .select()
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:edit_question_block_structured'),
        sql`${event.payload} @> ${JSON.stringify({ affected_blocks: [{ block_id: blockId }] })}::jsonb`,
      ),
    );

  // Dedup by event id (Q1/Q2 overlap when blockId is the primary of one edit and a merged_source of
  // another).
  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...q2]) byId.set(r.id, r);

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldQuestionBlock(blockId, foldEvents);
}

/**
 * Gather all events for `edgeId` and run the PURE edge fold against a CALLER-SUPPLIED live
 * topology mesh. READ-ONLY.
 *
 * This is the mesh-injected form used by full-table callers (the auditor). The live mesh is
 * the SAME for every edge in a single read-only scan, so a batch caller fetches it ONCE and
 * passes it here, instead of re-querying the entire live edge set per edge — turning an O(E²)
 * full-table audit into O(E). The single-edge `gatherAndFoldKnowledgeEdge` below is now a thin
 * wrapper that fetches the mesh then delegates here, so both paths fold IDENTICALLY (one
 * reducer, one mesh shape — the auditor can never diverge from the live write path).
 *
 * `liveMesh` MUST be the current archived_at IS NULL edge set, mapped via `edgeRowToSnapshot`.
 * It INCLUDES the edge being re-projected (self-inclusion) when that edge is itself live — this
 * is intentional-and-benign: checkEdgeTopology short-circuits a candidate already present in
 * `existing` (③ cycle finds no new reverse path from a self-edge; ④ transitive-redundancy is
 * skipped because the edge is alreadyDirect). A batch caller builds the mesh from the same live
 * snapshot it scans, so self-inclusion is preserved exactly as the per-edge fetch produced it.
 *
 * @throws when foldKnowledgeEdge rejects on ADR-0034 topology — NOT caught (propagates so the
 *         caller decides; the shell lets it abort the accept tx, the auditor surfaces it).
 */
export async function gatherAndFoldKnowledgeEdgeWithMesh(
  db: DbLike,
  edgeId: string,
  liveMesh: KnowledgeEdgeRowSnapshotT[],
): Promise<KnowledgeEdgeRowSnapshotT | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'knowledge_edge'), eq(event.subject_id, edgeId)));
  const foldEvents = rows.map(rowToFoldEvent);
  return foldKnowledgeEdge(edgeId, foldEvents, liveMesh);
}

/**
 * Gather all events for `edgeId` + the live topology mesh, then run the PURE edge fold.
 * READ-ONLY. Single-edge form: fetches the full live mesh itself, then delegates to
 * `gatherAndFoldKnowledgeEdgeWithMesh`. Used by the accept-time parity assert + IO shell where
 * each call is for ONE edge and the per-call mesh fetch is appropriate. Full-table callers
 * (the auditor) fetch the mesh once and call the WithMesh form to avoid the O(E²) re-fetch.
 *
 * @throws when foldKnowledgeEdge rejects on ADR-0034 topology — NOT caught (propagates so the
 *         caller decides; the shell lets it abort the accept tx, the auditor surfaces it).
 */
export async function gatherAndFoldKnowledgeEdge(
  db: DbLike,
  edgeId: string,
): Promise<KnowledgeEdgeRowSnapshotT | null> {
  const liveRows = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
  const liveMesh = liveRows.map(edgeRowToSnapshot);
  return gatherAndFoldKnowledgeEdgeWithMesh(db, edgeId, liveMesh);
}
