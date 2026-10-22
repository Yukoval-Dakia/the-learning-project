// Read-only gather+fold helpers shared by the projection write-through shells and the
// projection auditor. The shell writes the result through; the auditor deep-diffs it
// against the live row. Sharing one gather keeps the source-of-truth path and the drift
// audit from diverging in how a row is reconstructed.
//
// These functions only SELECT and fold; they never write.

import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import { foldArtifact } from '@/core/projections/artifact';
import { foldGoal } from '@/core/projections/goal';
import { foldItemCalibration } from '@/core/projections/item_calibration';
import { foldKnowledgeNode } from '@/core/projections/knowledge';
import { foldKnowledgeEdge } from '@/core/projections/knowledge_edge';
import { foldMistakeVariant } from '@/core/projections/mistake_variant';
import { foldQuestionBlock } from '@/core/projections/question_block';
import type {
  ArtifactRowSnapshotT,
  GoalRowSnapshotT,
  ItemCalibrationRowSnapshotT,
  KnowledgeEdgeRowSnapshotT,
  KnowledgeRowSnapshotT,
  MistakeVariantRowSnapshotT,
  QuestionBlockRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { rowToFoldEvent } from '@/kernel/records/projection-events';
import { getAnchorEventId } from './materialized-id-index';

export { gatherAndFoldLearningItem } from '@/kernel/records/learning-items';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;
type EdgeRow = typeof knowledge_edge.$inferSelect;

// Map a live edge row to the snapshot shape the fold produces. Both the mesh and the
// accept-time parity assert use this one mapper, so their shapes cannot drift.
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
 * Prefetch the node-independent merge leg, grouped by absorbed node id. A full-table
 * caller folds many nodes, so grouping once avoids rescanning every merge per node.
 */
export async function prefetchKnowledgeMergeEvents(db: DbLike): Promise<Map<string, EventRow[]>> {
  const merges = await db
    .select()
    .from(event)
    .where(eq(event.action, 'experimental:knowledge_merge'));
  // Index each merge under every from_id it archives (mirrors `payload -> 'from_ids' @> [nodeId]`:
  // absent/non-array/non-string from_ids index under no node, as `@>` returning NULL yields no match).
  const byFromId = new Map<string, EventRow[]>();
  for (const m of merges) {
    const fromIds = (m.payload as { from_ids?: unknown } | null)?.from_ids;
    if (!Array.isArray(fromIds)) continue;
    for (const fid of fromIds) {
      if (typeof fid !== 'string') continue;
      const list = byFromId.get(fid);
      if (list) list.push(m);
      else byFromId.set(fid, [m]);
    }
  }
  return byFromId;
}

/**
 * Prefetch knowledge-scoped rate events, grouped by the event they accept. The inner
 * join keeps only rates accepting a knowledge event, so a full-table fold does not load
 * every rate in the system.
 */
export async function prefetchKnowledgeRates(db: DbLike): Promise<Map<string, EventRow[]>> {
  const accepted = alias(event, 'accepted_event');
  const rows = await db
    .select()
    .from(event)
    .innerJoin(accepted, eq(event.caused_by_event_id, accepted.id))
    .where(and(eq(event.action, 'rate'), eq(accepted.subject_kind, 'knowledge')));
  const byCausedBy = new Map<string, EventRow[]>();
  for (const { event: r } of rows) {
    const cb = r.caused_by_event_id;
    if (cb === null) continue; // (join already excludes these; belt-and-suspenders for the map key)
    const list = byCausedBy.get(cb);
    if (list) list.push(r);
    else byCausedBy.set(cb, [r]);
  }
  return byCausedBy;
}

/**
 * Gather the events affecting `nodeId` and run the pure node fold. The gather combines
 * subject-keyed events, the reverse-index anchor for propose_new/split, a merge
 * containment scan, and the chained accept rates. Returns the projected row or null.
 */
export async function gatherAndFoldKnowledgeNode(
  db: DbLike,
  nodeId: string,
  prefetchedMergeEvents?: Map<string, EventRow[]>,
  prefetchedRates?: Map<string, EventRow[]>,
): Promise<KnowledgeRowSnapshotT | null> {
  // Q1: events whose subject_id is nodeId.
  // Covers genesis, auto_tag, reparent, archive, merge-as-into, and split-as-from.
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'knowledge'), eq(event.subject_id, nodeId)));

  // Q2: nodes born via propose_new/split have no event keyed on their own id. Their anchor
  // is the event the accept materialized them from; pull it plus everything caused by it.
  const anchorId = await getAnchorEventId(db, nodeId);
  const q2: EventRow[] = anchorId
    ? await db
        .select()
        .from(event)
        .where(or(eq(event.id, anchorId), eq(event.caused_by_event_id, anchorId)))
    : [];

  // Q3: a node merged into another appears only in the merge event's payload.from_ids.
  const q3 = prefetchedMergeEvents
    ? (prefetchedMergeEvents.get(nodeId) ?? [])
    : await db
        .select()
        .from(event)
        .where(
          and(
            eq(event.action, 'experimental:knowledge_merge'),
            sql`${event.payload} -> 'from_ids' @> ${JSON.stringify([nodeId])}::jsonb`,
          ),
        );

  // Dedup the gathered rows by event id; the legs overlap.
  const byId = new Map<string, EventRow>();
  for (const r of [...q1, ...q2, ...q3]) byId.set(r.id, r);

  // Rate resolution: the reducer needs the accept rates chained to the gathered events.
  const gatheredIds = [...byId.keys()];
  if (gatheredIds.length > 0) {
    if (prefetchedRates) {
      for (const gid of gatheredIds) {
        const chained = prefetchedRates.get(gid);
        if (!chained) continue;
        // Re-check the action so a future, wider prefetch set cannot absorb a non-rate event.
        for (const r of chained) if (r.action === 'rate') byId.set(r.id, r);
      }
    } else {
      const rates = await db
        .select()
        .from(event)
        .where(and(eq(event.action, 'rate'), inArray(event.caused_by_event_id, gatheredIds)));
      for (const r of rates) byId.set(r.id, r);
    }
  }

  const foldEvents = [...byId.values()].map(rowToFoldEvent);
  return foldKnowledgeNode(nodeId, foldEvents);
}

/**
 * Gather the events affecting `goalId` and run the pure goal fold. Goal ids are never
 * minted into a rate, so the gather is the subject-keyed events plus the chained
 * accept/retract events. Returns the projected row or null.
 */
export async function gatherAndFoldGoal(
  db: DbLike,
  goalId: string,
): Promise<GoalRowSnapshotT | null> {
  // Q1: subject-keyed events (genesis, the goal_scope proposal, status/scope updates).
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'goal'), eq(event.subject_id, goalId)));

  // The accept rate and retract correct target the proposal event, not the goal row.
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
 * Gather the events affecting `mvId` and run the pure mistake_variant fold. The base
 * event carries the proposal id; the lifecycle events are chained to that proposal, not
 * the variant row. Returns the projected row or null.
 */
export async function gatherAndFoldMistakeVariant(
  db: DbLike,
  mvId: string,
): Promise<MistakeVariantRowSnapshotT | null> {
  // Step 1: the base event (create or genesis) keyed on the variant id.
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

  // Step 2: the caused_by chain (accept/dismiss rate, verify, retract correct).
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
 * Gather the events affecting `artifactId` and run the pure artifact fold. Every artifact
 * event keys on the artifact id, so this is a single subject-keyed query. Returns the
 * projected row or null.
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
 * Gather the events affecting `blockId` and run the pure question_block fold. Besides the
 * subject-keyed events, it finds edit events that name this block as an absorbed
 * merged_source; that payload containment form is the one the GIN index accelerates.
 * Returns the projected row or null.
 */
export async function gatherAndFoldQuestionBlock(
  db: DbLike,
  blockId: string,
): Promise<QuestionBlockRowSnapshotT | null> {
  // Q1: events whose subject_id is blockId.
  const q1 = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'question_block'), eq(event.subject_id, blockId)));

  // Q2: edits keyed on another primary block that absorbed this block as a merged_source.
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
 * Gather the events affecting a calibration row and run the pure item_calibration fold.
 * The anchor-only fold consumes just the genesis seed, which is always subject-keyed.
 */
export async function gatherAndFoldItemCalibration(
  db: DbLike,
  rowId: string,
): Promise<ItemCalibrationRowSnapshotT | null> {
  const rows = await db
    .select()
    .from(event)
    .where(and(eq(event.subject_kind, 'item_calibration'), eq(event.subject_id, rowId)));
  const foldEvents = rows.map(rowToFoldEvent);
  return foldItemCalibration(rowId, foldEvents);
}

/**
 * Gather the events for `edgeId` and run the pure edge fold against a caller-supplied
 * live mesh. A batch caller fetches the mesh once, avoiding an O(E²) rescan. The mesh
 * includes the edge itself when live, which the topology check treats as already present.
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
 * Single-edge form: fetch the live mesh, then delegate. A topology reject propagates so
 * the caller decides whether to abort.
 */
export async function gatherAndFoldKnowledgeEdge(
  db: DbLike,
  edgeId: string,
): Promise<KnowledgeEdgeRowSnapshotT | null> {
  const liveRows = await db.select().from(knowledge_edge).where(isNull(knowledge_edge.archived_at));
  const liveMesh = liveRows.map(edgeRowToSnapshot);
  return gatherAndFoldKnowledgeEdgeWithMesh(db, edgeId, liveMesh);
}
