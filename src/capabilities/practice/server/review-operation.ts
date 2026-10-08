import { and, eq, exists, notExists, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { isBlankSlotResponse } from '@/core/schema/assessment/response';
import {
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
} from '@/core/schema/intervention';
import type { Db, Tx } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  event,
  learning_session,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  type BoundReviewAnswer,
  BoundReviewAnswerSchema,
  type ReviewAnswerAttachment,
  ReviewAnswerAttachmentSchema,
} from '@/kernel/tools/review-answer';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { type CreateAttemptBody, CreateAttemptBodySchema } from '../api/contracts';
import { normalizeReviewSubmitActivityRef } from './activity-ref';
import { recordAssistanceExposure } from './assessment/assistance';
import { commitFormalAttempt, prepareFormalAttemptSubmission } from './assessment/attempt';
import type { NativeAttemptDispatchPort } from './assessment/native-attempt-dispatch-port';
import { judgeDurableEnabled } from './judge-durable-config';
import { validatePlacementSubmission } from './placement-assessment';
import type { ReviewAnswerReceipt } from './tools/submit-review-answer';

type QuestionRow = typeof question.$inferSelect;

interface ValidatedSubmit {
  body: CreateAttemptBody;
  now: Date;
  questionId: string;
  q: QuestionRow;
}

async function validateSubmit(
  database: Db,
  body: CreateAttemptBody,
  now: Date,
): Promise<ValidatedSubmit> {
  const identity = normalizeReviewSubmitActivityRef(body);
  const questionId = identity.question_id;

  const qRows = await database.select().from(question).where(eq(question.id, questionId)).limit(1);
  const q = qRows[0];
  if (!q) {
    throw new ApiError('not_found', `question ${questionId} not found`, 404);
  }
  if (q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
    const diagnostic = InterventionDiagnosticQuestionMetadata.safeParse(
      q.metadata?.intervention_diagnostic,
    );
    if (!diagnostic.success) {
      throw new ApiError(
        'corrupt_state',
        `intervention diagnostic ${questionId} has invalid scheduling metadata`,
        500,
      );
    }
    if (q.judge_kind_override !== 'multimodal_direct') {
      throw new ApiError(
        'corrupt_state',
        `intervention diagnostic ${questionId} is missing its response-aware judge contract`,
        500,
      );
    }
    if (now.getTime() < new Date(diagnostic.data.due_at).getTime()) {
      throw new ApiError(
        'conflict',
        `intervention diagnostic ${questionId} is not due until ${diagnostic.data.due_at}`,
        409,
      );
    }
    if (
      body.assessment?.response_set.entries.every(isBlankSlotResponse) &&
      (body.assessment.group_evidence?.length ?? 0) === 0
    ) {
      throw new ApiError(
        'validation_error',
        `intervention diagnostic ${questionId} requires an answer`,
        400,
      );
    }
  }

  if (body.assessment) {
    await validatePlacementSubmission(database, questionId, body.session_id, body.assessment);
    const [issued] = await database
      .select({ container: assessment_issuance.container_occurrence_ref })
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, body.assessment.issuance_id));
    if (issued?.container?.startsWith('placement:')) {
      if (issued.container !== `placement:${body.session_id ?? ''}`)
        throw new ApiError(
          'coordinate_mismatch',
          'placement issuance belongs to another session',
          409,
        );
      const [session] = await database
        .select({ status: learning_session.status })
        .from(learning_session)
        .where(
          and(
            eq(learning_session.id, body.session_id ?? ''),
            eq(learning_session.type, 'placement'),
          ),
        );
      if (session?.status !== 'started')
        throw new ApiError('conflict', 'placement session is no longer active', 409);
    }
  }
  return { body, now, questionId, q };
}

async function claimInterventionDiagnosticSubmission(
  database: Db,
  validated: ValidatedSubmit,
): Promise<boolean> {
  if (validated.q.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) return false;

  const [claimed] = await database
    .update(question)
    .set({ draft_status: 'draft', updated_at: validated.now })
    .where(
      and(
        eq(question.id, validated.questionId),
        eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
        eq(question.draft_status, 'active'),
      ),
    )
    .returning({ id: question.id });
  if (!claimed) {
    // The claim protects the original, not its transport retries. The formal
    // writer still compares every accepted byte and rejects changed coordinates.
    const original = validated.body.assessment;
    if (original) {
      const [accepted] = await database
        .select({ id: assessment_submission.submission_id })
        .from(assessment_submission)
        .where(
          and(
            eq(assessment_submission.issuance_id, original.issuance_id),
            eq(assessment_submission.evaluation_group_id, original.evaluation_group_id),
            eq(assessment_submission.idempotency_key, original.idempotency_key),
          ),
        )
        .limit(1);
      if (accepted) return false;
    }
    throw new ApiError(
      'conflict',
      `intervention diagnostic ${validated.questionId} has already been submitted`,
      409,
    );
  }
  return true;
}

export async function releaseInterventionDiagnosticSubmissionClaim(
  input: { questionId: string; claimedAt: Date },
  database: Db,
): Promise<void> {
  await database
    .update(question)
    .set({ draft_status: 'active', updated_at: new Date() })
    .where(
      and(
        eq(question.id, input.questionId),
        eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
        eq(question.draft_status, 'draft'),
        eq(question.updated_at, input.claimedAt),
        exists(
          database
            .select({ id: question_group_lifecycle.group_id })
            .from(question_group_lifecycle)
            .where(
              and(
                eq(question_group_lifecycle.group_id, input.questionId),
                eq(question_group_lifecycle.scoring_admission_state, 'admitted'),
                eq(question_group_lifecycle.suspended, false),
                eq(question_group_lifecycle.withdrawn, false),
              ),
            ),
        ),
        notExists(
          database
            .select({ id: assessment_submission.submission_id })
            .from(assessment_submission)
            .innerJoin(
              question_revision,
              eq(question_revision.revision_id, assessment_submission.revision_id),
            )
            .where(eq(question_revision.group_id, input.questionId)),
        ),
      ),
    );
}

export async function sessionAdmitsDurableDivert(
  database: Db,
  sessionId: string | null,
): Promise<boolean> {
  if (sessionId === null) return true;
  const rows = await database
    .select({ type: learning_session.type })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const type = rows[0]?.type ?? null;
  // Unknown session id → treat as NOT admitted. The synchronous path is always correct; it is
  // only slower, so an unresolvable session must fail closed.
  if (type === null) return false;
  return DURABLE_DIVERT_SESSION_TYPES.has(type);
}

/**
 * The session types whose clients are known to tolerate the 202-pending contract. W2 =
 * practice review only. W3 admits the remaining faces as each one's client learns to wait for
 * the backfill (design §4/§5, YUK-777).
 */
const DURABLE_DIVERT_SESSION_TYPES: ReadonlySet<string> = new Set(['review']);

export interface ReviewAnswerContext {
  signal?: AbortSignal;
  now?: Date;
  /** Runtime dispatch policy only; session admission remains a domain decision. */
  durableEnabled?: boolean;
  /** YUK-1355 owns the transport selection and recovery behind this existing port. */
  dispatchNativeAttempt?: NativeAttemptDispatchPort;
}

export type ReviewAnswerResult =
  | { kind: 'pending'; run_id: string }
  | { kind: 'committed'; committed: Awaited<ReturnType<typeof commitFormalAttempt>> };

/**
 * Submit an authorized learner original. Network callers own authentication and
 * parsing; model tool arguments are never authority for a learner submission.
 * Rejections, conflicts, cancellation and execution errors remain thrown errors.
 */
export async function submitReviewAnswer(
  database: Db,
  body: CreateAttemptBody,
  context: ReviewAnswerContext = {},
): Promise<ReviewAnswerResult> {
  let claimedDiagnostic: ValidatedSubmit | null = null;
  let retainDiagnosticClaim = false;
  try {
    context.signal?.throwIfAborted();
    const validated = await validateSubmit(database, body, context.now ?? new Date());
    const assessment = body.assessment;
    if (!assessment) {
      throw new ApiError(
        'historical_unknown',
        'solo submission requires its original issued assessment',
        409,
      );
    }
    context.signal?.throwIfAborted();
    if (await claimInterventionDiagnosticSubmission(database, validated)) {
      claimedDiagnostic = validated;
    }
    context.signal?.throwIfAborted();
    if (!body.self_report && !body.activation_intent) {
      const dispatch =
        context.dispatchNativeAttempt ??
        (await import('./assessment/durable-attempt')).dispatchNativeAttempt;
      const runId = await dispatch(
        database,
        validated.questionId,
        { ...assessment, now: validated.now },
        {
          enabled:
            (context.durableEnabled ?? (judgeDurableEnabled() && shouldEnqueueBackgroundJobs())) &&
            (await sessionAdmitsDurableDivert(database, body.session_id ?? null)),
          capture: body,
          userRating: body.auto_rate ? undefined : body.rating,
          requireUnassistedModelEvidence:
            validated.q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
        },
      );
      if (runId !== null) {
        retainDiagnosticClaim = true;
        return { kind: 'pending', run_id: runId };
      }
    }
    context.signal?.throwIfAborted();
    const committed = await commitFormalAttempt(
      database,
      'solo_submit',
      validated.questionId,
      { ...assessment, now: validated.now },
      {
        activationIntent: body.activation_intent,
        selfReport: body.self_report,
        userRating: body.auto_rate ? undefined : body.rating,
        capture: body,
        signal: context.signal,
        requireUnassistedModelEvidence:
          validated.q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
      },
    );
    retainDiagnosticClaim = true;
    return { kind: 'committed', committed };
  } catch (err) {
    if (claimedDiagnostic !== null && !retainDiagnosticClaim) {
      const claim = claimedDiagnostic;
      await releaseInterventionDiagnosticSubmissionClaim(
        { questionId: claim.questionId, claimedAt: claim.now },
        database,
      ).catch((releaseError) => {
        console.error('[review-operation] diagnostic claim release failed', {
          questionId: claim.questionId,
          error: releaseError,
        });
      });
    }
    throw err;
  }
}

async function reviewBindingCoordinates(
  database: Db | Tx,
  original: Pick<ReviewAnswerAttachment, 'question_id' | 'review_session_id'> & {
    assessment: { issuance_id: string };
  },
) {
  const [issued] = await database
    .select()
    .from(assessment_issuance)
    .where(eq(assessment_issuance.issuance_id, original.assessment.issuance_id));
  const [revision] = issued
    ? await database
        .select({ groupId: question_revision.group_id })
        .from(question_revision)
        .where(eq(question_revision.revision_id, issued.revision_id))
    : [];
  if (!issued || !revision) throw new ApiError('not_found', 'issued original not found', 404);
  if (
    issued.container_occurrence_ref !== null ||
    (revision.groupId !== original.question_id && !issued.part_ids.includes(original.question_id))
  ) {
    throw new ApiError(
      'coordinate_mismatch',
      'original is outside the standalone review issuance',
      409,
    );
  }
  if (original.review_session_id) {
    const [session] = await database
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, original.review_session_id));
    if (session?.type !== 'review' || session.status !== 'started') {
      throw new ApiError('coordinate_mismatch', 'review session is not active', 409);
    }
  }
  return issued;
}

/** Runs in the authenticated chat acceptance transaction, before any model execution. */
export async function captureReviewAnswerBinding(
  database: Tx,
  input: {
    sessionId: string;
    originalRef: string;
    original: ReviewAnswerAttachment;
  },
): Promise<BoundReviewAnswer> {
  const original = ReviewAnswerAttachmentSchema.parse(input.original);
  const issued = await reviewBindingCoordinates(database, original);
  // The same assessment retry identity cannot acquire a second chat/session authority.
  await database.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review-answer:${original.assessment.evaluation_group_id}:${original.assessment.idempotency_key}`}, 0))`,
  );
  const [prior] = await database
    .select({ id: event.id })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:copilot_user_ask'),
        sql`${event.payload}->'review_answer'->'original'->'assessment'->>'evaluation_group_id' = ${original.assessment.evaluation_group_id}`,
        sql`${event.payload}->'review_answer'->'original'->'assessment'->>'idempotency_key' = ${original.assessment.idempotency_key}`,
      ),
    )
    .limit(1);
  if (prior && prior.id !== input.originalRef) {
    throw new ApiError(
      'review_original_conflict',
      'original is already bound to another chat turn',
      409,
    );
  }
  // Match saveSubmission's group → issuance order before the assistance snapshot.
  await database.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(${original.assessment.evaluation_group_id}))`,
  );
  const [accepted] = await database
    .select({ id: assessment_submission.submission_id })
    .from(assessment_submission)
    .where(
      and(
        eq(assessment_submission.evaluation_group_id, original.assessment.evaluation_group_id),
        eq(assessment_submission.idempotency_key, original.assessment.idempotency_key),
      ),
    );
  if (!accepted)
    await recordAssistanceExposure(database, {
      issuanceId: original.assessment.issuance_id,
      questionId: original.question_id,
      kind: 'chat_context',
      impact: 'unknown',
      contentDigest: canonicalHash(original),
    });
  const saved = await prepareFormalAttemptSubmission(
    database,
    'solo_submit',
    original.question_id,
    original.assessment,
  );
  const {
    response_set: _responses,
    group_evidence: _evidence,
    ...coordinates
  } = original.assessment;
  return {
    version: 1,
    submission_id: saved.submission.submission_id,
    original_ref: input.originalRef,
    session_id: input.sessionId,
    revision_id: issued.revision_id,
    original_sha256: canonicalHash(original),
    original: { ...original, assessment: coordinates },
  };
}

/** The authenticated consumer owns authorization; the operation owns original/final truth. */
export async function consumeReviewAnswerBinding(
  database: Db,
  raw: BoundReviewAnswer,
  context: ReviewAnswerContext & {
    authorize: (tx: Tx) => Promise<void>;
  },
): Promise<ReviewAnswerReceipt> {
  const binding = BoundReviewAnswerSchema.parse(raw);
  // Permission checks serialize with Stop/retraction; no lock spans the judge/provider call.
  const original = await database.transaction(async (tx) => {
    await context.authorize(tx);
    context.signal?.throwIfAborted();
    const issued = await reviewBindingCoordinates(tx, binding.original);
    const [accepted] = await tx
      .select()
      .from(assessment_submission)
      .where(eq(assessment_submission.submission_id, binding.submission_id));
    const ref = binding.original.assessment;
    if (
      !accepted ||
      accepted.issuance_id !== ref.issuance_id ||
      accepted.revision_id !== binding.revision_id ||
      issued.revision_id !== binding.revision_id ||
      accepted.evaluation_group_id !== ref.evaluation_group_id ||
      accepted.idempotency_key !== ref.idempotency_key ||
      (ref.submission_id !== undefined && ref.submission_id !== accepted.submission_id)
    ) {
      throw new ApiError(
        'review_original_modified',
        'immutable original coordinates do not match',
        409,
      );
    }
    const reconstructed = ReviewAnswerAttachmentSchema.parse({
      ...binding.original,
      assessment: {
        ...ref,
        response_set: accepted.response_set,
        group_evidence: accepted.group_evidence,
      },
    });
    if (canonicalHash(reconstructed) !== binding.original_sha256) {
      throw new ApiError('review_original_modified', 'bound original digest does not match', 409);
    }
    return reconstructed;
  });
  const body = CreateAttemptBodySchema.parse({
    question_id: original.question_id,
    assessment: original.assessment,
    session_id: original.review_session_id ?? null,
    reasoning_trace: original.reasoning_trace,
    rating: 'good',
    auto_rate: true,
  });
  const result = await submitReviewAnswer(database, body, context);
  if (result.kind === 'pending') return result;
  return {
    kind: 'committed',
    status: result.committed.status,
    submission_id: result.committed.submission.submission_id,
    attempt_id: result.committed.attempt_id,
    candidate_id: result.committed.candidate.evaluation.record.evaluation_id,
  };
}
