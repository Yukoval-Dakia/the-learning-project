// Atomic learner-profile refresh intents. A canonical writer appends one intent
// inside its own transaction after every fact write and final receipt. `seq`
// comes from a dedicated sequence — it is allocation order at nextval() time,
// not commit order, so a later-committing intent can carry a smaller seq.
// Freshness is decided by the pending-intent set alone, never by seq,
// MAX(event_id) or created_at, so a late-committing intent can never be
// skipped by a worker high-water mark.
// Append is idempotent on (knowledge_id, source_kind, source_ref): retries and
// replays of the same canonical operation collapse to one intent.

import { createId } from '@paralleldrive/cuid2';
import type { Tx } from '@/db/client';
import { learner_profile_refresh_intent } from '@/db/schema';

export const PROFILE_INTENT_SOURCE = {
  settlement: 'assessment_settlement',
} as const;

/**
 * Idempotent insert of one refresh intent for one KC. `sourceRef` is the
 * canonical operation's durable identity (for settlement, the settlement
 * event id sealed in the receipt). Re-inserting the same tuple is a no-op.
 */
export async function appendLearnerProfileIntent(
  tx: Tx,
  input: { knowledgeId: string; sourceKind: string; sourceRef: string },
): Promise<void> {
  await tx
    .insert(learner_profile_refresh_intent)
    .values({
      id: `lpi_${createId()}`,
      knowledge_id: input.knowledgeId,
      source_kind: input.sourceKind,
      source_ref: input.sourceRef,
    })
    .onConflictDoNothing({
      target: [
        learner_profile_refresh_intent.knowledge_id,
        learner_profile_refresh_intent.source_kind,
        learner_profile_refresh_intent.source_ref,
      ],
    });
}
