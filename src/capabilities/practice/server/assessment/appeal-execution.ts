import { and, eq, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import {
  EvaluationAdmissionSnapshot,
  type EvaluationAdmissionSnapshotT,
  EvaluationInputSnapshot,
  type EvaluationInputSnapshotT,
  EvaluationProvenance,
  type EvaluationProvenanceT,
} from '@/core/schema/assessment';
import { AiProposalPayload } from '@/core/schema/proposal';
import type { Tx } from '@/db/client';
import {
  type assessment_issuance,
  type assessment_submission,
  evaluation,
  event,
} from '@/db/schema';
import { getCorrectionStatus, writeEvent } from '@/kernel/events';
import { lockEventCorrectionsAll } from '@/kernel/events/correction-lock';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
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
          eq(event.action, bindingAction),
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
      // Legacy receipts used this exact appeal as parent; retain them without rewriting.
      // New operational bindings stay outside the business-resolution child surface.
      (prior.caused_by_event_id !== null && prior.caused_by_event_id !== appeal.id) ||
      !parsed.success ||
      canonicalHash(BindingIdentity.parse(parsed.data)) !== canonicalHash(identity)
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

/** The original correction owner supplies retained identities, never a bypass callback.
 * An already activated original can be corrected after its conversation closes;
 * a never-activated original must still pass the conversation's first-use gate.
 * Caller holds learning-state G. The native activation owns group/CAS/withdrawal
 * and writes its usual receipt together with the correction resolution.
 */
export async function authorizeConfirmationCorrection(
  tx: Tx,
  input: {
    candidate: typeof evaluation.$inferSelect;
    submission: typeof assessment_submission.$inferSelect;
    issuance: typeof assessment_issuance.$inferSelect;
    correction: { appealEventId: string; priorEvaluationId: string };
    expected_effective_id: string | null;
    expected_generation: number;
  },
): Promise<void> {
  const reject = (detail: string): never => {
    throw new ApiError('confirmation_unbound', detail, 409);
  };
  const { candidate, submission, issuance, correction } = input;
  await lockEventCorrectionsAll(tx);
  const provenance = EvaluationProvenance.safeParse(candidate.provenance);
  const context = provenance.success ? provenance.data.review_context : undefined;
  if (
    !provenance.success ||
    !context ||
    context.appeal_event_id !== correction.appealEventId ||
    context.prior_evaluation_id !== correction.priorEvaluationId
  )
    return reject('correction does not identify its sealed candidate');
  const [appeal] = await tx.select().from(event).where(eq(event.id, correction.appealEventId));
  const [prior] = await tx
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, correction.priorEvaluationId));
  const priorProvenance = EvaluationProvenance.safeParse(prior?.provenance);
  if (
    appeal?.action !== 'experimental:appeal_request' ||
    appeal.actor_kind !== 'user' ||
    appeal.subject_kind !== 'evaluation' ||
    appeal.subject_id !== prior?.evaluation_id ||
    appeal.payload.evaluation_group_id !== candidate.evaluation_group_id ||
    appeal.payload.expected_effective_id !== input.expected_effective_id ||
    appeal.payload.expected_generation !== input.expected_generation ||
    (appeal.payload.reason_md ?? '') !== context.reason_md ||
    prior?.status !== 'completed' ||
    prior.submission_id !== submission.submission_id ||
    prior.evaluation_group_id !== candidate.evaluation_group_id ||
    !priorProvenance.success ||
    !priorProvenance.data.input_snapshot ||
    !provenance.data.input_snapshot ||
    canonicalHash(priorProvenance.data.input_snapshot) !==
      canonicalHash(provenance.data.input_snapshot)
  )
    return reject('correction differs from the retained appeal or frozen original');
  const occurrenceId = issuance.container_occurrence_ref?.slice(
    'conversation-confirmation:'.length,
  );
  const [binding] = await tx
    .select()
    .from(event)
    .where(eq(event.id, `confirmation-assessment:${occurrenceId}`));
  const [original] = await tx
    .select()
    .from(event)
    .where(eq(event.id, `confirmation-original:${occurrenceId}`));
  if (
    binding?.action !== 'experimental:confirmation_assessment' ||
    binding.payload.version !== 1 ||
    binding.payload.occurrence_id !== occurrenceId ||
    binding.subject_kind !== 'issuance' ||
    binding.subject_id !== issuance.issuance_id ||
    binding.payload.issuance_id !== issuance.issuance_id ||
    binding.payload.revision_id !== submission.revision_id ||
    binding.payload.evaluation_group_id !== candidate.evaluation_group_id ||
    binding.payload.submission_id !== submission.submission_id ||
    original?.action !== 'experimental:confirmation_original' ||
    original.payload.version !== 1 ||
    original.payload.occurrence_id !== occurrenceId ||
    original.session_id !== binding.session_id ||
    original.subject_kind !== 'submission' ||
    original.subject_id !== submission.submission_id ||
    original.payload.submission_id !== submission.submission_id ||
    original.payload.original_digest !==
      canonicalHash({
        response_set: submission.response_set,
        group_evidence: submission.group_evidence,
      })
  )
    return reject('correction has no bound immutable conversation original');
  const [activated] = await tx
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_activation'),
        eq(event.subject_kind, 'evaluation_group'),
        eq(event.subject_id, candidate.evaluation_group_id),
        sql`${event.payload}->>'submission_id' = ${submission.submission_id}`,
        sql`${event.payload}->>'issuance_id' = ${issuance.issuance_id}`,
      ),
    )
    .limit(1);
  if (!activated) return reject('first activation still requires conversation authorization');
  const key = provenance.data.execution_receipt?.key;
  const sources = [
    appeal.id,
    original.id,
    ...(appeal.caused_by_event_id ? [appeal.caused_by_event_id] : []),
  ];
  if (provenance.data.source === 'automatic') {
    const [execution] = await tx
      .select()
      .from(event)
      .where(
        eq(event.id, `evt_appeal_binding_${canonicalHash([candidate.evaluation_group_id, key])}`),
      );
    const parsed = Binding.safeParse(execution?.payload);
    if (
      key !== `appeal:${appeal.id}` ||
      execution?.action !== bindingAction ||
      !parsed.success ||
      parsed.data.appeal_event_id !== appeal.id ||
      parsed.data.evaluation_group_id !== candidate.evaluation_group_id ||
      parsed.data.execution_key !== key ||
      parsed.data.submission_id !== submission.submission_id ||
      parsed.data.attempt !== candidate.attempt ||
      parsed.data.intent_digest !== provenance.data.execution_receipt?.intent_digest ||
      canonicalHash(parsed.data.input_snapshot) !== canonicalHash(provenance.data.input_snapshot)
    )
      return reject('correction candidate has no original appeal execution receipt');
  } else if (
    provenance.data.source === 'manual' &&
    typeof appeal.payload.proposal_event_id === 'string'
  ) {
    const [proposal] = await tx
      .select()
      .from(event)
      .where(eq(event.id, appeal.payload.proposal_event_id));
    const payload = AiProposalPayload.safeParse(proposal?.payload.ai_proposal);
    const change =
      payload.success && payload.data.kind === 'judge_retraction'
        ? payload.data.proposed_change
        : undefined;
    if (
      proposal?.action !== 'experimental:proposal' ||
      !payload.success ||
      payload.data.kind !== 'judge_retraction' ||
      payload.data.target.subject_kind !== 'evaluation' ||
      payload.data.target.subject_id !== prior.evaluation_id ||
      appeal.caused_by_event_id !== proposal.id ||
      key !== `correction:${proposal.id}` ||
      change?.correction_kind !== 'assert' ||
      change.evaluation_id !== prior.evaluation_id ||
      change.expected_effective_id !== input.expected_effective_id ||
      change.expected_generation !== input.expected_generation
    )
      return reject('manual correction has no retained assertion proposal');
    sources.push(proposal.id);
  } else return reject('unsupported confirmation correction authority');
  for (const id of sources) {
    if (
      (await getCorrectionStatus(tx, id)).state !== 'active' ||
      (await readEventDerivationPolicy(tx, id)) !== 'allow'
    )
      return reject('correction authority was withdrawn or restricted');
  }
}
