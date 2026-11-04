import { and, eq, or, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type {
  EvaluationAdmissionSnapshotT,
  EvaluationInputSnapshotT,
  EvaluationProvenanceT,
} from '@/core/schema/assessment';
import type { Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  APPEAL_EXECUTION_BINDING_ACTION,
  AppealExecutionBinding,
  AppealExecutionBindingIdentity,
  appealExecutionBindingId,
} from '@/kernel/records/appeal-execution-binding';

function conflict(detail: string): never {
  throw new ApiError('appeal_execution_conflict', detail, 409);
}

/** Called under the assessment-evaluation-group lock, including by non-appeal
 * allocators. Appeal reservations and historical paid claims occupy slots before
 * candidate sealing; an unclaimed native binding keeps the existing collision
 * policy: an intervening candidate may occupy the slot, and its recovering owner
 * must then hold rather than spend. */
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
        eq(event.subject_kind, 'evaluation_group'),
        eq(event.subject_id, groupId),
        or(
          eq(event.action, APPEAL_EXECUTION_BINDING_ACTION),
          eq(event.action, 'experimental:assessment_model_claim'),
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

/** A real appeal owns this binding independently of the native pending-run protocol.
 * The caller commits the receipt before executing any unit; recovery never resets it. */
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

  const identity = AppealExecutionBindingIdentity.parse({
    version: 1,
    appeal_event_id: appeal.id,
    evaluation_group_id: input.evaluation_group_id,
    submission_id: input.submission_id,
    execution_key: input.execution_key,
    input_snapshot: input.input_snapshot,
    intent_digest: input.intent_digest,
  });
  const bindingId = appealExecutionBindingId(input.evaluation_group_id, input.execution_key);
  const read = async () => {
    const [prior] = await tx.select().from(event).where(eq(event.id, bindingId)).limit(1);
    if (!prior) return null;
    const parsed = AppealExecutionBinding.safeParse(prior.payload);
    if (
      prior.action !== APPEAL_EXECUTION_BINDING_ACTION ||
      prior.subject_kind !== 'evaluation_group' ||
      prior.subject_id !== input.evaluation_group_id ||
      // Legacy receipts used this exact appeal as parent; retain them without rewriting.
      // New operational bindings stay outside the business-resolution child surface.
      (prior.caused_by_event_id !== null && prior.caused_by_event_id !== appeal.id) ||
      !parsed.success ||
      canonicalHash(AppealExecutionBindingIdentity.parse(parsed.data)) !== canonicalHash(identity)
    )
      conflict('immutable appeal binding differs; no fresh execution permitted');
    return parsed.data;
  };
  const prior = await read();
  if (prior) return prior;

  // A legacy appeal may already have spent under any earlier attempt, even if another
  // appeal later sealed that slot. Those claims cannot be attributed from their digest
  // alone: only a binding that preceded the claim establishes ownership, so a later
  // binding cannot launder an old unknown claim. Native bindings alone cannot attribute
  // a historical claim either. Hold model work instead of guessing. This is causal
  // ordering, not a completeness cursor; compare dispatch_seq in SQL, never in JS.
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
          WHERE binding.action = ${APPEAL_EXECUTION_BINDING_ACTION}
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
  const binding = AppealExecutionBinding.parse({
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
    action: APPEAL_EXECUTION_BINDING_ACTION,
    subject_kind: 'evaluation_group',
    subject_id: input.evaluation_group_id,
    outcome: null,
    // Operational identity is bindingId + the validated appeal/input payload; only
    // business resolutions belong to the appeal's caused_by child surface.
    caused_by_event_id: null,
    payload: binding,
    created_at: now,
    ingest_at: now,
  });
  const saved = await read();
  if (!saved) conflict('appeal binding missing after persistence');
  return saved;
}
