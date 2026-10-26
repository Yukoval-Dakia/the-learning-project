// Learning-item repair keeps its caller lock and causal clock in the server owner.

import type { z } from 'zod';
import { newId } from '@/core/ids';
import type {
  LearningItemKnowledgeIdsRewriteExperimental,
  LearningItemStateRestoreExperimental,
} from '@/core/schema/event/learning-item-events';
import type { Tx } from '@/db/client';
import { nextProjectionEventTime, writeEvent } from '@/kernel/events';
import {
  hasLearningItemGenesisAnchor,
  projectLearningItemGuarded,
} from '@/kernel/records/learning-items';

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
