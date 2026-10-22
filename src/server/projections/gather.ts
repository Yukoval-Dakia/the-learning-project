// Read-only gather+fold helpers shared by the projection write-through shells and the
// projection auditor. The shell writes the result through; the auditor deep-diffs it
// against the live row. Sharing one gather keeps the source-of-truth path and the drift
// audit from diverging in how a row is reconstructed.
//
// These functions only SELECT and fold; they never write.

import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { foldArtifact } from '@/core/projections/artifact';
import { foldGoal } from '@/core/projections/goal';
import { foldItemCalibration } from '@/core/projections/item_calibration';
import { foldKnowledgeEdge } from '@/core/projections/knowledge_edge';
import { foldMistakeVariant } from '@/core/projections/mistake_variant';
import type {
  ArtifactRowSnapshotT,
  GoalRowSnapshotT,
  ItemCalibrationRowSnapshotT,
  KnowledgeEdgeRowSnapshotT,
  MistakeVariantRowSnapshotT,
} from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event, knowledge_edge } from '@/db/schema';
import { rowToFoldEvent } from '@/kernel/records/projection-events';

export { gatherAndFoldKnowledgeNode } from '@/kernel/records/knowledge-node-history';
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

export { gatherAndFoldQuestionBlock } from '@/kernel/records/question-block-projection';

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
