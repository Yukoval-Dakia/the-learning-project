// Lifecycle-only admission closure preserves the frozen revision and unresolved payment.
import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Tx } from '@/db/client';
import { event, question, question_group_lifecycle } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  ASSESSMENT_PUBLISH_ACTION,
  type AdmissionVerificationWrite,
  appendAdmissionVerificationRecord,
} from './assessment-publication';

/** Close a pending admission without rereading assets or changing the frozen contract. */
export async function closePendingQuestionAdmission(
  tx: Tx,
  input: {
    groupId: string;
    expectedRevisionId: string;
    expectedGeneration: number;
    verification: AdmissionVerificationWrite;
    now: Date;
  },
): Promise<'closed' | 'stale'> {
  const [root] = await tx
    .select({ id: question.id })
    .from(question)
    .where(eq(question.id, input.groupId))
    .for('update');
  const [lifecycle] = await tx
    .select()
    .from(question_group_lifecycle)
    .where(eq(question_group_lifecycle.group_id, input.groupId))
    .for('update');
  if (
    !root ||
    !lifecycle ||
    lifecycle.current_revision_id !== input.expectedRevisionId ||
    lifecycle.scoring_admission_generation !== input.expectedGeneration ||
    lifecycle.scoring_admission_state !== 'withheld' ||
    lifecycle.scoring_admission_withheld_reason !== 'unverified_rules' ||
    lifecycle.withdrawn ||
    lifecycle.suspended
  )
    return 'stale';
  const generation = input.expectedGeneration + 1;
  await tx
    .update(question_group_lifecycle)
    .set({
      scoring_admission_state: 'withheld',
      scoring_admission_evidence: null,
      scoring_admission_withheld_reason: 'verification_failed',
      scoring_admission_decided_at: null,
      scoring_admission_generation: generation,
      updated_at: input.now,
    })
    .where(eq(question_group_lifecycle.group_id, input.groupId));
  await appendAdmissionVerificationRecord(tx, {
    ...input,
    expectedGeneration: generation,
  });
  const [publication] = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, ASSESSMENT_PUBLISH_ACTION),
        sql`${event.payload}->>'group_id' = ${input.groupId}`,
        sql`${event.payload}->>'revision_id' = ${input.expectedRevisionId}`,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(1);
  await writeEvent(tx, {
    id: createId(),
    session_id: null,
    actor_kind: 'system',
    actor_ref: 'practice:question_admission',
    caused_by_event_id: publication?.id ?? null,
    action: ASSESSMENT_PUBLISH_ACTION,
    subject_kind: 'question',
    subject_id: input.groupId,
    outcome: 'success',
    payload: {
      group_id: input.groupId,
      revision_id: input.expectedRevisionId,
      dimension_update: true,
      availability: lifecycle.availability,
      admission: 'withheld',
      admission_generation: generation,
      verification: {
        policy_id: input.verification.policy_id,
        outcome: input.verification.outcome,
      },
    },
    created_at: input.now,
  });
  return 'closed';
}
