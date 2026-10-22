// Read-only gather+fold helpers shared by the projection write-through shells and the
// projection auditor. The shell writes the result through; the auditor deep-diffs it
// against the live row. Sharing one gather keeps the source-of-truth path and the drift
// audit from diverging in how a row is reconstructed.
//
// These functions only SELECT and fold; they never write.

import { and, eq, inArray, or } from 'drizzle-orm';

import { foldItemCalibration } from '@/core/projections/item_calibration';
import type { ItemCalibrationRowSnapshotT } from '@/core/schema/event/genesis';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { rowToFoldEvent } from '@/kernel/records/projection-events';

export { gatherAndFoldGoal } from '@/kernel/records/goal-history';
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
