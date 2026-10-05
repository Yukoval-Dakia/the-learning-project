// Solo submissions require the original issued assessment. Candidate activation
// is the only learning writer; durable work uses the same immutable original.
import { and, eq } from 'drizzle-orm';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { CauseCategoryT } from '@/core/schema/event/blocks';
import type { JudgeExecutionProvenanceT } from '@/core/schema/event/known';
import {
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
} from '@/core/schema/intervention';
import { type Db, db } from '@/db/client';
import { learning_session, question } from '@/db/schema';
import {
  ApiError,
  canonicalResourceResponse,
  deprecatedRouteResponse,
  errorResponse,
} from '@/kernel/http';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import type { SubjectProfile } from '@/subjects/profile';
import { normalizeReviewSubmitActivityRef } from '../server/activity-ref';
import { commitFormalAttempt } from '../server/assessment/attempt';
import type { JudgeInvokerOutput } from '../server/judge';
import { judgeDurableEnabled } from '../server/judge-durable-config';
import { ratingFromCoarseOutcome } from '../server/judge-rating';
import { JUDGE_RUN_TABLE } from '../server/judge-run-status';
import { type CreateAttemptBody, CreateAttemptBodySchema } from './contracts';

type Rating = CreateAttemptBody['rating'];
type SubmitBodyT = CreateAttemptBody;
type QuestionRow = typeof question.$inferSelect;

export interface ValidatedSubmit {
  body: SubmitBodyT;
  now: Date;
  questionId: string;
  activityRef: ReturnType<typeof normalizeReviewSubmitActivityRef>['activity_ref'];
  q: QuestionRow;
}

async function validateSubmit(req: Request): Promise<ValidatedSubmit> {
  const raw = await req.json().catch(() => null);
  const parsed = CreateAttemptBodySchema.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ApiError('validation_error', message, 400);
  }
  const body = parsed.data;
  const now = new Date();
  const identity = normalizeReviewSubmitActivityRef(body);
  const questionId = identity.question_id;

  // Confirm the question exists + load full row for judge (YUK-56). The
  // judge needs kind / prompt_md / reference_md / rubric_json / choices_md /
  // judge_kind_override / knowledge_ids / metadata / figures / image_refs /
  // structured — i.e. everything in the question table.
  const qRows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
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
    if ((body.response_md?.trim().length ?? 0) === 0 && body.answer_image_refs.length === 0) {
      throw new ApiError(
        'validation_error',
        `intervention diagnostic ${questionId} requires an answer`,
        400,
      );
    }
  }

  return { body, now, questionId, activityRef: identity.activity_ref, q };
}

async function claimInterventionDiagnosticSubmission(validated: ValidatedSubmit): Promise<boolean> {
  if (validated.q.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) return false;

  const [claimed] = await db
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
  database: Db = db,
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
      ),
    );
}

/** Historical settlement fixture shape; no live submit or worker invokes the old scorer. */
export interface JudgedSubmit {
  judgeResult: JudgeResultV2T | null;
  judgeRoute: string | null;
  judgeTelemetry: JudgeInvokerOutput['telemetry'] | null;
  executionProvenance: JudgeExecutionProvenanceT | null;
  suggestedRating: Rating | null;
  finalRating: Rating;
  adviceCauseCategory: CauseCategoryT | null;
  /**
   * YUK-739 — the profile the rating-advisory lean/ratingPolicy resolves
   * through in historical settlement records (null when no answer was submitted).
   */
  adviceSubjectProfile: SubjectProfile | null;
}

/**
 * W4 #TtWh_ (codex P1) — may a submit from THIS session be answered with a 202-pending?
 *
 * `/api/attempts` is shared. The placement probe posts through it with `auto_rate:true`
 * (`onboarding/ui/placement-api.ts` submitProbeAnswer) and then — `ScreenPlacement.tsx:192-194`
 * — immediately calls `/question-selections` for the next item. `placement-next.ts` computes
 * the answered set from PERSISTED review/attempt events keyed by `session_id`, so under a 202
 * the current question is not yet in the exclusion set: answeredCount stalls, the termination
 * check keeps the old value, and the probe can re-serve the question it just answered. The
 * W2 divert was written for the practice face and this shared entry point was the leak.
 *
 * The gate is an ALLOWLIST, not a placement deny-list: any session type that is not explicitly
 * admitted stays synchronous. A future caller mounting on this route therefore cannot silently
 * inherit the async contract — it has to opt in here, which is the point at which someone has
 * to check that its client actually tolerates a pending verdict.
 *
 * A submit with NO session_id is ad-hoc solo practice (the practice face's own shape) → admitted.
 */
export async function sessionAdmitsDurableDivert(sessionId: string | null): Promise<boolean> {
  if (sessionId === null) return true;
  const rows = await db
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

/**
 * #8 — EXPLICIT marker for "this response is a durable-judge divert". `createAttemptResource`
 * used to key on the bare `status === 202`, which silently assumes every 202 this route can
 * ever produce is a pending-judge body with no `review_event`; the day another 202 appears
 * for an unrelated reason, that heuristic hands the client a raw body and skips the resource
 * wrapper. A named header is a discriminant that cannot be reached by accident.
 */
export const DURABLE_DIVERT_HEADER = 'x-durable-divert';
export const DURABLE_DIVERT_JUDGE = 'judge';

/** The 202-pending contract body returned when a submit diverts to the durable lane. */
export interface DurableJudgePendingResponse {
  run_id: string;
  /** discriminant clients branch on (vs a resolved `judge` verdict). */
  verdict: 'pending';
  backfill: {
    channel: 'sse';
    url: string;
    poll_url: string;
  };
}

/** Build the 202-pending response for `runId` (body + Location + the #8 divert header). */
function durablePendingResponse(runId: string): Response {
  const eventsUrl = `/api/jobs/${JUDGE_RUN_TABLE}/${encodeURIComponent(runId)}/events`;
  const pollUrl = `/api/jobs/${JUDGE_RUN_TABLE}/${encodeURIComponent(runId)}/status`;
  const responseBody: DurableJudgePendingResponse = {
    run_id: runId,
    verdict: 'pending',
    backfill: { channel: 'sse', url: eventsUrl, poll_url: pollUrl },
  };
  return Response.json(responseBody, {
    status: 202,
    headers: { Location: eventsUrl, [DURABLE_DIVERT_HEADER]: DURABLE_DIVERT_JUDGE },
  });
}

export async function createAttempt(req: Request): Promise<Response> {
  let claimedDiagnostic: ValidatedSubmit | null = null;
  let retainDiagnosticClaim = false;
  try {
    const validated = await validateSubmit(req);
    if (!validated.body.assessment) {
      throw new ApiError(
        'historical_unknown',
        'solo submission requires its original issued assessment',
        409,
      );
    }
    if (await claimInterventionDiagnosticSubmission(validated)) {
      claimedDiagnostic = validated;
    }
    {
      const { body, questionId } = validated;
      if (!body.self_report && !body.activation_intent) {
        const { dispatchNativeAttempt } = await import('../server/assessment/durable-attempt');
        const runId = await dispatchNativeAttempt(
          db,
          questionId,
          { ...body.assessment!, now: validated.now },
          {
            enabled:
              judgeDurableEnabled() &&
              shouldEnqueueBackgroundJobs() &&
              (await sessionAdmitsDurableDivert(body.session_id ?? null)),
            capture: body,
            userRating: body.auto_rate ? undefined : body.rating,
            requireUnassistedModelEvidence:
              validated.q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
          },
        );
        if (runId) {
          retainDiagnosticClaim = true;
          return durablePendingResponse(runId);
        }
      }
      const committed = await commitFormalAttempt(
        db,
        'solo_submit',
        questionId,
        validated.body.assessment,
        {
          activationIntent: body.activation_intent,
          selfReport: body.self_report,
          userRating: body.auto_rate ? undefined : body.rating,
          capture: body,
          signal: req.signal,
          requireUnassistedModelEvidence:
            validated.q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
        },
      );
      retainDiagnosticClaim = true;
      const judged = committed.candidate.result;
      return Response.json({
        status: committed.status,
        assessment: {
          submission_id: committed.submission.submission_id,
          evaluation_group_id: committed.submission.evaluation_group_id,
          candidate_id: committed.candidate.evaluation.record.evaluation_id,
          activation_intent: committed.activation_intent,
          effect: committed.status === 'effective' ? committed.activation.effect : null,
        },
        review_event: { id: committed.attempt_id },
        judge: body.self_report
          ? null
          : {
              route: 'evaluate_submission',
              score: judged.score,
              coarse_outcome: judged.coarse_outcome,
              confidence: judged.confidence,
              feedback_md: judged.feedback_md,
              evidence_json: judged.evidence_json,
              capability_ref: judged.capability_ref,
              suggested_rating: ratingFromCoarseOutcome(judged.coarse_outcome),
              auto_rated: body.auto_rate,
              judge_event_id: null,
            },
      });
    }
  } catch (err) {
    if (claimedDiagnostic !== null && !retainDiagnosticClaim) {
      await releaseInterventionDiagnosticSubmissionClaim({
        questionId: claimedDiagnostic.questionId,
        claimedAt: claimedDiagnostic.now,
      }).catch((releaseError) => {
        console.error(
          `failed to release intervention diagnostic submission claim for ${claimedDiagnostic?.questionId}:`,
          releaseError,
        );
      });
    }
    return errorResponse(err);
  }
}

export async function createAttemptResource(req: Request): Promise<Response> {
  const inner = await createAttempt(req);
  // YUK-594 — a durable divert returns 202-pending, whose body has NO `review_event`;
  // canonicalResourceResponse derives Location from `review_event.id`, so it would blow
  // up on the pending shape. Pass it through untouched — durablePendingResponse already set
  // its own Location header (the run's SSE stream), which is the correct resource.
  // #8 — keyed on the EXPLICIT divert header, not a bare 202: an unrelated future 202 from
  // this route must still go through the resource wrapper rather than leak a raw body.
  if (inner.headers.get(DURABLE_DIVERT_HEADER) === DURABLE_DIVERT_JUDGE) return inner;
  return canonicalResourceResponse(inner, {
    outcome: 'created',
    location: (body) =>
      `/api/events/${encodeURIComponent(
        (body as { review_event: { id: string } }).review_event.id,
      )}`,
  });
}

export async function POST(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await createAttempt(req), '/api/attempts');
}
