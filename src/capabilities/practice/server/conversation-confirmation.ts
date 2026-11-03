// Assessment ownership for conversation confirmations. Conversation lifecycle and
// permissions stay with the caller; issuance, originals and receipt recovery stay here.
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import { type GroupEvidenceT, type ResponseSetT, ResponseSpec } from '@/core/schema/assessment';
import { WHOLE_PAPER_SLOT_KINDS } from '@/core/schema/assessment/slot-renderers';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  evaluation,
  evaluation_effective_head,
  event,
  knowledge,
  learning_item,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { issueAssessment } from '@/kernel/records/assessment-issuance';
import { CreateAttemptBodySchema } from '../api/contracts';
import {
  getIssuanceState,
  recordAssistanceExposure,
  saveSubmission,
  submitReviewAnswer,
} from '../grading/public';

const Binding = z
  .object({
    version: z.literal(1),
    occurrence_id: z.string(),
    session_id: z.string(),
    learning_item_id: z.string(),
    question_id: z.string(),
    revision_id: z.string(),
    issuance_id: z.string(),
    evaluation_group_id: z.string(),
    idempotency_key: z.string(),
    submission_id: z.string(),
  })
  .strict();
const Original = z
  .object({
    version: z.literal(1),
    occurrence_id: z.string(),
    command_id: z.string(),
    original_digest: z.string(),
    submission_id: z.string(),
  })
  .strict();
type BindingT = z.infer<typeof Binding>;
const bindingId = (id: string) => `confirmation-assessment:${id}`;
const submissionId = (id: string) => `confirmation-original:${id}`;

async function readBinding(db: Db | Tx, occurrenceId: string): Promise<BindingT | null> {
  const [row] = await db
    .select()
    .from(event)
    .where(eq(event.id, bindingId(occurrenceId)));
  if (!row) return null;
  if (row.action !== 'experimental:confirmation_assessment')
    throw new ApiError('confirmation_incompatible', 'invalid assessment binding', 409);
  const parsed = Binding.safeParse(row.payload);
  if (!parsed.success)
    throw new ApiError('confirmation_incompatible', 'unsupported assessment binding', 409);
  return parsed.data;
}

/** Caller holds its session lock; issuance, binding and conservative help are one commit. */
export async function issueConversationConfirmation(
  tx: Tx,
  input: {
    occurrenceId: string;
    sessionId: string;
    learningItemId: string;
  },
) {
  const prior = await readBinding(tx, input.occurrenceId);
  if (prior) {
    if (prior.session_id !== input.sessionId || prior.learning_item_id !== input.learningItemId)
      throw new ApiError('confirmation_conflict', 'confirmation binding changed', 409);
    return { status: 'issued' as const, issuance_id: prior.issuance_id };
  }
  const [li] = await tx
    .select()
    .from(learning_item)
    .where(eq(learning_item.id, input.learningItemId));
  if (!li) throw new ApiError('not_found', 'teaching target no longer exists', 404);
  const live = li.knowledge_ids.length
    ? await tx
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(and(inArray(knowledge.id, li.knowledge_ids), isNull(knowledge.archived_at)))
    : [];
  if (!live.length) return { status: 'blocked' as const, reason: 'target_scope_unknown' };
  const scope = live.map((k) => k.id);
  const candidates = await tx
    .select({ q: question, r: question_revision })
    .from(question)
    .innerJoin(question_group_lifecycle, eq(question.id, question_group_lifecycle.group_id))
    .innerJoin(
      question_revision,
      eq(question_revision.revision_id, question_group_lifecycle.current_revision_id),
    )
    .where(
      and(
        eq(question.draft_status, 'active'),
        isNull(question.parent_question_id),
        eq(question_group_lifecycle.scoring_admission_state, 'admitted'),
        eq(question_group_lifecycle.availability, 'general_pool'),
        eq(question_revision.availability, 'general_pool'),
        sql`${question.knowledge_ids} ?| array[${sql.join(
          scope.map((k) => sql`${k}`),
          sql`, `,
        )}]::text[]`,
        sql`NOT EXISTS (SELECT 1 FROM ${assessment_issuance} i JOIN ${event} b
        ON b.payload->>'issuance_id' = i.issuance_id
        WHERE b.action = 'experimental:confirmation_assessment'
        AND b.session_id = ${input.sessionId} AND i.group_id = ${question.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${event} a WHERE a.session_id = ${input.sessionId}
        AND a.action = 'experimental:copilot_user_ask'
        AND a.payload->'review_answer'->'original'->>'question_id' = ${question.id})`,
      ),
    )
    .orderBy(asc(question.id));
  let reason = 'no_admitted_single_question';
  for (const { q, r } of candidates) {
    const spec = ResponseSpec.safeParse(r.response_spec);
    if (!spec.success) {
      reason = 'invalid_scoring_contract';
      continue;
    }
    if (spec.data.slots.length !== 1) continue;
    // Same native per-slot / PresentationBlocks capability as ordinary Practice.
    // issueAssessment still validates the complete frozen presentation and serving.
    if (!WHOLE_PAPER_SLOT_KINDS.has(spec.data.slots[0].kind)) {
      reason = 'no_input_renderer';
      continue;
    }
    const structure = r.structure as { parts?: unknown[] };
    if (structure.parts?.length !== 1) continue;
    const uses = q.metadata?.allowed_uses;
    if (Array.isArray(uses) && uses.length && !uses.includes('practice')) continue;
    if (
      q.metadata?.archived_at ||
      q.metadata?.dismissed_at ||
      q.metadata?.exposure_blocked === true
    )
      continue;
    const expiry = q.metadata?.expires_at ?? q.metadata?.expired_at;
    if (expiry != null && (typeof expiry !== 'string' || !(Date.parse(expiry) > Date.now())))
      continue;
    const issued = await issueAssessment(tx, {
      group_id: q.id,
      revision_id: r.revision_id,
      mode: 'auto_score',
      issuance_id: `iss_confirmation_${input.occurrenceId}`,
      container_occurrence_ref: `conversation-confirmation:${input.occurrenceId}`,
      actorRef: 'conversation-confirmation',
    });
    if (!('issuance' in issued)) {
      reason = issued.serving_reason ?? issued.status;
      continue;
    }
    const binding = Binding.parse({
      version: 1,
      occurrence_id: input.occurrenceId,
      session_id: input.sessionId,
      learning_item_id: li.id,
      question_id: q.id,
      revision_id: r.revision_id,
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: `eg_confirmation_${input.occurrenceId}`,
      idempotency_key: `confirmation:${input.occurrenceId}`,
      submission_id: `sub_confirmation_${input.occurrenceId}`,
    });
    await recordAssistanceExposure(tx, {
      issuanceId: binding.issuance_id,
      questionId: q.id,
      kind: 'chat_context',
      impact: 'unknown',
      contentDigest: canonicalHash({ occurrence: input.occurrenceId, session: input.sessionId }),
    });
    await writeEvent(tx, {
      id: bindingId(input.occurrenceId),
      session_id: input.sessionId,
      actor_kind: 'system',
      actor_ref: 'conversation-confirmation',
      action: 'experimental:confirmation_assessment',
      subject_kind: 'issuance',
      subject_id: binding.issuance_id,
      payload: binding,
    });
    return { status: 'issued' as const, issuance_id: binding.issuance_id };
  }
  return { status: 'blocked' as const, reason };
}

/** Reserve the immutable original once, then use the original native submission transport. */
export async function submitConversationConfirmation(
  db: Db,
  input: {
    occurrenceId: string;
    sessionId: string;
    commandId: string;
    responseSet: ResponseSetT;
    groupEvidence: GroupEvidenceT[];
    authorize: (tx: Tx) => Promise<void>;
    signal: AbortSignal;
  },
) {
  const prepared = await db.transaction(async (tx) => {
    await input.authorize(tx);
    input.signal.throwIfAborted();
    const binding = await readBinding(tx, input.occurrenceId);
    if (!binding || binding.session_id !== input.sessionId)
      throw new ApiError('confirmation_unbound', 'confirmation assessment is not bound', 409);
    const original = { response_set: input.responseSet, group_evidence: input.groupEvidence };
    const digest = canonicalHash(original);
    const [prior] = await tx
      .select()
      .from(event)
      .where(eq(event.id, submissionId(input.occurrenceId)));
    if (prior) {
      if (!Original.safeParse(prior.payload).success)
        throw new ApiError('confirmation_incompatible', 'unsupported confirmation original', 409);
      if (prior.payload.original_digest !== digest)
        throw new ApiError('confirmation_conflict', 'accepted original bytes differ', 409);
      return null;
    }
    const assessment = {
      issuance_id: binding.issuance_id,
      evaluation_group_id: binding.evaluation_group_id,
      idempotency_key: binding.idempotency_key,
      submission_id: binding.submission_id,
      ...original,
    };
    await writeEvent(tx, {
      id: submissionId(input.occurrenceId),
      session_id: input.sessionId,
      actor_kind: 'user',
      actor_ref: 'user:self',
      action: 'experimental:confirmation_original',
      subject_kind: 'submission',
      subject_id: binding.submission_id,
      payload: {
        version: 1,
        occurrence_id: input.occurrenceId,
        command_id: input.commandId,
        original_digest: digest,
        submission_id: binding.submission_id,
      },
    });
    const saved = await saveSubmission(tx, assessment);
    if (!('submission' in saved))
      throw new ApiError(saved.status, 'original was not accepted', 409);
    return CreateAttemptBodySchema.parse({
      question_id: binding.question_id,
      session_id: input.sessionId,
      assessment,
      rating: 'good',
      auto_rate: true,
    });
  });
  if (prepared) {
    // A real conversation session preserves the existing native transport policy;
    // no synthetic review session is used to obtain durable eligibility.
    await submitReviewAnswer(db, prepared, {
      signal: input.signal,
      authorize: input.authorize,
      confirmationOccurrenceId: input.occurrenceId,
    });
  }
  return readConversationConfirmation(db, input.occurrenceId);
}

/** Read authoritative rows and receipts only; recovery never issues, submits or judges. */
export async function readConversationConfirmation(db: Db | Tx, occurrenceId: string) {
  const binding = await readBinding(db, occurrenceId);
  if (!binding) return null;
  const issued = await getIssuanceState(db, binding.issuance_id);
  const submissions = await db
    .select()
    .from(assessment_submission)
    .where(eq(assessment_submission.issuance_id, binding.issuance_id));
  const original = submissions.find((s) => s.submission_id === binding.submission_id);
  const [acceptedOriginal] = await db
    .select()
    .from(event)
    .where(eq(event.id, submissionId(occurrenceId)));
  if (acceptedOriginal && !Original.safeParse(acceptedOriginal.payload).success)
    throw new ApiError('confirmation_incompatible', 'unsupported confirmation original', 409);
  if (original && !acceptedOriginal)
    throw new ApiError(
      'confirmation_unbound',
      'submission has no accepted confirmation command',
      409,
    );
  const candidates = original
    ? await db
        .select()
        .from(evaluation)
        .where(eq(evaluation.submission_id, original.submission_id))
        .orderBy(desc(evaluation.attempt))
    : [];
  const [head] = original
    ? await db
        .select()
        .from(evaluation_effective_head)
        .where(eq(evaluation_effective_head.evaluation_group_id, original.evaluation_group_id))
    : [];
  const receipts = original
    ? await db
        .select({ id: event.id, action: event.action, payload: event.payload })
        .from(event)
        .where(
          and(
            inArray(event.action, [
              'attempt',
              'experimental:assessment_submission',
              'experimental:assessment_activation',
              'experimental:assessment_settlement',
              'experimental:assessment_judge_resolution',
              'experimental:assessment_appeal_resolution',
              'experimental:appeal_request',
              'experimental:judge_pending_attempt',
            ]),
            sql`(${event.payload}->>'submission_id' = ${original.submission_id}
        OR ${event.payload}->'submit'->>'submission_id' = ${original.submission_id}
        OR (${event.subject_kind} = 'evaluation' AND EXISTS (
          SELECT 1 FROM ${evaluation} e WHERE e.submission_id = ${original.submission_id}
          AND e.evaluation_id = ${event.subject_id})))`,
          ),
        )
        .orderBy(asc(event.created_at), asc(event.id))
    : [];
  const pending = original
    ? await db
        .select({ id: event.id, payload: event.payload })
        .from(event)
        .where(eq(event.id, `evt_pending_judge_native_${original.submission_id}`))
    : [];
  const activation = receipts
    .filter(
      (r) =>
        r.action === 'experimental:assessment_activation' &&
        r.payload.evaluation_id === head?.effective_evaluation_id,
    )
    .at(-1);
  const settlement = receipts
    .filter(
      (r) =>
        r.action === 'experimental:assessment_settlement' &&
        r.payload.evaluation_id === head?.effective_evaluation_id,
    )
    .at(-1);
  return {
    ...binding,
    issuance_state: issued,
    result: !original
      ? ('issued' as const)
      : head?.effective_evaluation_id
        ? activation?.payload.effect === 'failed_pending' ||
          settlement?.payload.effect === 'failed_pending'
          ? ('failed_pending' as const)
          : ('effective' as const)
        : pending.length
          ? ('pending' as const)
          : candidates.some((c) => c.status === 'completed') &&
              receipts.some((r) => r.id === `evt_assessment_${original.submission_id}`)
            ? ('review_required' as const)
            : ('failed_pending' as const),
    submission: original ?? null,
    candidates,
    effective_head: head ?? null,
    pending_run_id: pending.length ? `judge_native_${original?.submission_id}` : null,
    receipts,
    independent_mastery: false as const,
    evidence_scope: 'chat_context_unknown' as const,
    exposure_history: 'partial_unknown' as const,
  };
}
