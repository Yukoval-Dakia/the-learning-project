import { and, eq, exists, notExists } from 'drizzle-orm';
import { isBlankSlotResponse } from '@/core/schema/assessment/response';
import {
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
} from '@/core/schema/intervention';
import type { Db } from '@/db/client';
import {
  assessment_issuance,
  assessment_submission,
  learning_session,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import type { CreateAttemptBody } from '../api/contracts';
import { normalizeReviewSubmitActivityRef } from './activity-ref';
import { commitFormalAttempt } from './assessment/attempt';
import type { NativeAttemptDispatchPort } from './assessment/native-attempt-dispatch-port';
import { judgeDurableEnabled } from './judge-durable-config';
import { validatePlacementSubmission } from './placement-assessment';

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
