// Compatibility HTTP adapter; domain admission and submission live in review-operation.
import { db } from '@/db/client';
import { canonicalResourceResponse, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import {
  DURABLE_DIVERT_HEADER,
  DURABLE_DIVERT_JUDGE,
  durablePendingResponse,
} from '../server/review-answer-response';
import { requestReviewAnswer } from '../server/review-operation';

export async function createAttempt(req: Request): Promise<Response> {
  try {
    const response = await requestReviewAnswer(db, () => req.json(), { signal: req.signal });
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
