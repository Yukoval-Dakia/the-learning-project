// Compatibility HTTP adapter; domain admission and submission live in review-operation.
import { db } from '@/db/client';
import {
  ApiError,
  canonicalResourceResponse,
  deprecatedRouteResponse,
  errorResponse,
} from '@/kernel/http';
import { projectReviewAnswerResponse } from '../server/review-answer-response';
import { submitReviewAnswer } from '../server/review-operation';
import { CreateAttemptBodySchema } from './contracts';

/**
 * EXPLICIT marker for "this response is a durable-judge divert". `createAttemptResource`
 * used to key on the bare `status === 202`, which silently assumes every 202 this route can
 * ever produce is a pending-judge body with no `review_event`; the day another 202 appears
 * for an unrelated reason, that heuristic hands the client a raw body and skips the resource
 * wrapper. A named header is a discriminant that cannot be reached by accident.
 */
export const DURABLE_DIVERT_HEADER = 'x-durable-divert';
export const DURABLE_DIVERT_JUDGE = 'judge';

/** The 202-pending contract body returned when a submit diverts to the durable lane. */
export type DurableJudgePendingResponse = Extract<
  ReturnType<typeof projectReviewAnswerResponse>,
  { kind: 'pending' }
>['body'];

/** Preserve the HTTP status and headers around the shared pending JSON. */
function durablePendingResponse(responseBody: DurableJudgePendingResponse): Response {
  return Response.json(responseBody, {
    status: 202,
    headers: {
      Location: responseBody.backfill.url,
      [DURABLE_DIVERT_HEADER]: DURABLE_DIVERT_JUDGE,
    },
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
    const response = projectReviewAnswerResponse(body, result);
    if (response.kind === 'pending') return durablePendingResponse(response.body);
    return Response.json(response.body);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createAttemptResource(req: Request): Promise<Response> {
  const inner = await createAttempt(req);
  // A durable divert returns 202-pending, whose body has NO `review_event`;
  // canonicalResourceResponse derives Location from `review_event.id`, so it would blow
  // up on the pending shape. Pass it through untouched — durablePendingResponse already set
  // its own Location header (the run's SSE stream), which is the correct resource.
  // keyed on the EXPLICIT divert header, not a bare 202: an unrelated future 202 from
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
