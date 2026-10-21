// Write-through shell for the pure `learning_item` fold. The gather is subject-keyed.
// child_learning_item_ids / ai_score / due_at / reviewed_at are derived state outside the
// snapshot, so they stay at their defaults on insert and untouched on update. The shared
// gather lives in gather.ts.

import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { newId } from '@/core/ids';
import type { LearningItemRowSnapshotT } from '@/core/schema/event/genesis';
import type {
  LearningItemKnowledgeIdsRewriteExperimental,
  LearningItemStateRestoreExperimental,
} from '@/core/schema/event/learning-item-events';
import type { Db, Tx } from '@/db/client';
import { learning_item } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { nextProjectionEventTime } from './event-clock';
import { gatherAndFoldLearningItem } from './gather';
import { hasLearningItemGenesisAnchor } from './parity';

type DbLike = Db | Tx;

/**
 * Re-project one `learning_item`. A fold of null deletes the row; otherwise upsert the
 * snapshot columns.
 */
export async function projectLearningItem(db: DbLike, itemId: string): Promise<void> {
  const projected = await gatherAndFoldLearningItem(db, itemId);
  if (projected === null) {
    await db.delete(learning_item).where(eq(learning_item.id, itemId));
    return;
  }
  await upsertProjectedLearningItem(db, projected);
}

/**
 * Guarded write-through: a fold of null deletes only when the row has a genesis anchor.
 * Without one the fold is blind to a pre-event row, so deleting would lose data.
 */
export async function projectLearningItemGuarded(db: DbLike, itemId: string): Promise<void> {
  const projected = await gatherAndFoldLearningItem(db, itemId);
  if (projected === null) {
    if (await hasLearningItemGenesisAnchor(db, itemId)) {
      await db.delete(learning_item).where(eq(learning_item.id, itemId));
    }
    // else: fold-blind pre-event-sourced item — keep the imperative row (NEVER delete).
    return;
  }
  await upsertProjectedLearningItem(db, projected);
}

// Upsert the snapshot columns. Derived columns stay at their defaults on insert and
// untouched on update because the fold does not own them.
async function upsertProjectedLearningItem(
  db: DbLike,
  projected: LearningItemRowSnapshotT,
): Promise<void> {
  await db
    .insert(learning_item)
    .values({
      id: projected.id,
      source: projected.source,
      source_ref: projected.source_ref,
      title: projected.title,
      content: projected.content,
      knowledge_ids: projected.knowledge_ids,
      primary_artifact_id: projected.primary_artifact_id,
      parent_learning_item_id: projected.parent_learning_item_id,
      status: projected.status,
      user_pinned: projected.user_pinned,
      completed_at: projected.completed_at,
      dismissed_at: projected.dismissed_at,
      archived_at: projected.archived_at,
      archived_reason: projected.archived_reason,
      created_at: projected.created_at,
      updated_at: projected.updated_at,
      version: projected.version,
    })
    .onConflictDoUpdate({
      target: learning_item.id,
      set: {
        source: projected.source,
        source_ref: projected.source_ref,
        title: projected.title,
        content: projected.content,
        knowledge_ids: projected.knowledge_ids,
        primary_artifact_id: projected.primary_artifact_id,
        parent_learning_item_id: projected.parent_learning_item_id,
        status: projected.status,
        user_pinned: projected.user_pinned,
        completed_at: projected.completed_at,
        dismissed_at: projected.dismissed_at,
        archived_at: projected.archived_at,
        archived_reason: projected.archived_reason,
        created_at: projected.created_at,
        updated_at: projected.updated_at,
        version: projected.version,
      },
    });
}

type LearningItemRepairEvent =
  | z.infer<typeof LearningItemKnowledgeIdsRewriteExperimental>
  | z.infer<typeof LearningItemStateRestoreExperimental>;

/** Caller holds the item row lock. Anchor, causal time, append and projection stay inseparable. */
export async function applyLearningItemRepair(
  tx: Tx,
  input: LearningItemRepairEvent,
  requestedAt: Date,
): Promise<void> {
  if (!(await hasLearningItemGenesisAnchor(tx, input.subject_id))) {
    throw new Error(`Learning item ${input.subject_id} needs canonical projection migration`);
  }
  const createdAt = await nextProjectionEventTime(
    tx,
    'learning_item',
    input.subject_id,
    requestedAt,
  );
  await writeEvent(tx, { ...input, id: newId(), created_at: createdAt, ingest_at: requestedAt });
  await projectLearningItemGuarded(tx, input.subject_id);
}
