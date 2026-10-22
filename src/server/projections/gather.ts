// Read-only gather+fold helpers shared by the projection write-through shells and the
// projection auditor. The shell writes the result through; the auditor deep-diffs it
// against the live row. Sharing one gather keeps the source-of-truth path and the drift
// audit from diverging in how a row is reconstructed.
//
// These functions only SELECT and fold; they never write.

import { and, eq, inArray, or } from 'drizzle-orm';

import { foldGoal } from '@/core/projections/goal';
import { foldItemCalibration } from '@/core/projections/item_calibration';
import type { GoalRowSnapshotT, ItemCalibrationRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { rowToFoldEvent } from '@/kernel/records/projection-events';

export {
  edgeRowToSnapshot,
  gatherAndFoldKnowledgeEdge,
  gatherAndFoldKnowledgeEdgeWithMesh,
} from '@/kernel/records/knowledge-edge-facts';
export { gatherAndFoldKnowledgeNode } from '@/kernel/records/knowledge-node-history';
export { gatherAndFoldLearningItem } from '@/kernel/records/learning-items';
// Canonical implementation; retained for the retract-clock DB consumer.
export { gatherAndFoldMistakeVariant } from '@/kernel/records/mistake-variant-facts';

type DbLike = Db | Tx;
type EventRow = typeof event.$inferSelect;

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

export { gatherAndFoldArtifact } from '@/kernel/records/artifact-history';

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
