// Appeal request adjudication: verifies that a confirmation correction candidate
// still identifies its retained appeal, immutable conversation original and — for
// the automatic lane — grading's own appeal execution receipt (consumed via the
// receipt contract grading publishes).
import { and, eq, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { EvaluationProvenance } from '@/core/schema/assessment';
import { AiProposalPayload } from '@/core/schema/proposal';
import type { Tx } from '@/db/client';
import {
  type assessment_issuance,
  type assessment_submission,
  evaluation,
  event,
} from '@/db/schema';
import { getCorrectionStatus } from '@/kernel/events';
import { lockEventCorrectionsAll } from '@/kernel/events/correction-lock';
import { readEventDerivationPolicy } from '@/kernel/events/derivation-policy';
import { ApiError } from '@/kernel/http';
import {
  APPEAL_EXECUTION_BINDING_ACTION,
  AppealExecutionBinding,
  appealExecutionBindingId,
} from '../../grading/public';

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
      .where(eq(event.id, appealExecutionBindingId(candidate.evaluation_group_id, key)));
    const parsed = AppealExecutionBinding.safeParse(execution?.payload);
    if (
      key !== `appeal:${appeal.id}` ||
      execution?.action !== APPEAL_EXECUTION_BINDING_ACTION ||
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
