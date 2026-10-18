import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import {
  EvaluationAdmissionSnapshot,
  type EvaluationAdmissionSnapshotT,
  EvaluationInputSnapshot,
  type EvaluationInputSnapshotT,
  type EvaluationProvenanceT,
} from '@/core/schema/assessment';
import type { Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';

const bindingAction = 'experimental:assessment_appeal_execution_binding';
const BindingIdentity = z.object({
  version: z.literal(1),
  appeal_event_id: z.string().min(1),
  evaluation_group_id: z.string().min(1),
  submission_id: z.string().min(1),
  execution_key: z.string().min(1),
  input_snapshot: EvaluationInputSnapshot,
  intent_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
});
const Binding = BindingIdentity.extend({
  attempt: z.number().int().positive().safe(),
  admission_snapshot: EvaluationAdmissionSnapshot.nullable(),
  model_hold_reason: z.string().min(1).nullable(),
}).strict();

function conflict(detail: string): never {
  throw new ApiError('appeal_execution_conflict', detail, 409);
}

/** Called under assessment-evaluation-group, including by non-appeal allocators.
 * Unsealed reservations and historical claims occupy slots just as sealed candidates do.
 * Reading a native binding reserves its slot; it never grants another run its authority.
 */
export async function reservedEvaluationAttempt(
  tx: Tx,
  groupId: string,
  submissionId: string,
): Promise<number> {
  const receipts = await tx
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        sql`${event.payload}->>'submission_id' = ${submissionId}`,
        or(
          and(
            eq(event.action, 'experimental:judge_execution_binding'),
            sql`${event.payload}->>'evaluation_group_id' = ${groupId}`,
          ),
          and(
            eq(event.subject_kind, 'evaluation_group'),
            eq(event.subject_id, groupId),
            or(
              eq(event.action, bindingAction),
              eq(event.action, 'experimental:assessment_model_claim'),
            ),
          ),
        ),
      ),
    );
  let last = 0;
  for (const { payload } of receipts) {
    const attempt = payload.attempt;
    if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt < 1)
      conflict('invalid retained attempt reservation; explicit recovery required');
    last = Math.max(last, attempt);
  }
  return last;
}

/** A real appeal owns this binding, independently of the native pending-run protocol.
 * The caller commits this receipt before executing any unit. No receipt is reset on recovery.
 */
export async function bindAppealExecution(
  tx: Tx,
  input: {
    evaluation_group_id: string;
    submission_id: string;
    execution_key: string;
    input_snapshot: EvaluationInputSnapshotT;
    intent_digest: string;
    review_context: NonNullable<EvaluationProvenanceT['review_context']>;
    next_attempt: number;
    admission_snapshot: EvaluationAdmissionSnapshotT | null;
  },
) {
  const [appeal] = await tx
    .select()
    .from(event)
    .where(eq(event.id, input.review_context.appeal_event_id))
    .limit(1);
  if (
    appeal?.action !== 'experimental:appeal_request' ||
    appeal.subject_kind !== 'evaluation' ||
    appeal.subject_id !== input.review_context.prior_evaluation_id ||
    appeal.payload.evaluation_group_id !== input.evaluation_group_id ||
    (appeal.payload.reason_md ?? '') !== input.review_context.reason_md ||
    input.execution_key !== `appeal:${appeal.id}`
  )
    conflict('execution does not identify the retained appeal and grading intent');

  const identity = BindingIdentity.parse({
    version: 1,
    appeal_event_id: appeal.id,
    evaluation_group_id: input.evaluation_group_id,
    submission_id: input.submission_id,
    execution_key: input.execution_key,
    input_snapshot: input.input_snapshot,
    intent_digest: input.intent_digest,
  });
  const bindingId = `evt_appeal_binding_${canonicalHash([
    input.evaluation_group_id,
    input.execution_key,
  ])}`;
  const read = async () => {
    const [prior] = await tx.select().from(event).where(eq(event.id, bindingId)).limit(1);
    if (!prior) return null;
    const parsed = Binding.safeParse(prior.payload);
    if (
      prior.action !== bindingAction ||
      prior.subject_kind !== 'evaluation_group' ||
      prior.subject_id !== input.evaluation_group_id ||
      prior.caused_by_event_id !== appeal.id ||
      !parsed.success ||
      canonicalHash(BindingIdentity.parse(parsed.data)) !== canonicalHash(identity)
    )
      conflict('immutable appeal binding differs; no fresh execution permitted');
    return parsed.data;
  };
  const prior = await read();
  if (prior) return prior;

  // Compatibility: an old appeal may already have spent under ANY earlier attempt,
  // even if a different appeal subsequently sealed that slot. Those claims cannot
  // be attributed from their digest alone. Only a binding that preceded the claim
  // establishes appeal ownership; a later binding cannot launder an old unknown claim.
  // Old allocators could collide with native pending slots, so a native binding
  // alone cannot attribute a historical claim to that run rather than this appeal.
  // Hold model work instead of guessing. New appeals can pass other bound appeals.
  // This is direct causal ordering (appeal commit precedes its claims), not a
  // subscription completeness cursor. Compare in SQL, never as JS sequence numbers.
  const [legacyClaim] = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_model_claim'),
        eq(event.subject_kind, 'evaluation_group'),
        eq(event.subject_id, input.evaluation_group_id),
        sql`${event.dispatch_seq} > (SELECT dispatch_seq FROM event WHERE id = ${appeal.id})`,
        sql`NOT EXISTS (
          SELECT 1 FROM event AS binding
          WHERE binding.action = ${bindingAction}
            AND binding.subject_kind = 'evaluation_group'
            AND binding.subject_id = ${input.evaluation_group_id}
            AND binding.payload->>'evaluation_group_id' = ${input.evaluation_group_id}
            AND binding.payload->>'submission_id' = ${event.payload}->>'submission_id'
            AND binding.payload->>'attempt' = ${event.payload}->>'attempt'
            AND binding.dispatch_seq < ${event.dispatch_seq}
        )`,
      ),
    )
    .limit(1);
  const binding = Binding.parse({
    ...identity,
    attempt: input.next_attempt,
    admission_snapshot: input.admission_snapshot,
    model_hold_reason: legacyClaim
      ? 'historical appeal has model claims without a durable binding; explicit recovery required'
      : null,
  });
  const now = new Date();
  await writeEvent(tx, {
    id: bindingId,
    actor_kind: 'system',
    actor_ref: 'assessment:appeal',
    action: bindingAction,
    subject_kind: 'evaluation_group',
    subject_id: input.evaluation_group_id,
    outcome: null,
    caused_by_event_id: appeal.id,
    payload: binding,
    created_at: now,
    ingest_at: now,
  });
  const saved = await read();
  if (!saved) conflict('appeal binding missing after persistence');
  return saved;
}
