// Compatibility HTTP adapter; domain admission and submission live in review-operation.
import { db } from '@/db/client';
import {
  ApiError,
  canonicalResourceResponse,
  deprecatedRouteResponse,
  errorResponse,
} from '@/kernel/http';
import { ratingFromCoarseOutcome } from '../server/judge-rating';
import { JUDGE_RUN_TABLE } from '../server/judge-run-status';
import { submitReviewAnswer } from '../server/review-operation';
import { CreateAttemptBodySchema } from './contracts';

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
  try {
    const parsed = CreateAttemptBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const body = parsed.data;
    const result = await submitReviewAnswer(db, body, { signal: req.signal });
    if (result.kind === 'pending') return durablePendingResponse(result.run_id);
    const committed = result.committed;
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
  } catch (err) {
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
