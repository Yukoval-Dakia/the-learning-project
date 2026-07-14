import { deprecatedRouteResponse } from '@/kernel/http';
import { POST as createReviewSession } from './review-sessions';

export async function POST(req: Request): Promise<Response> {
  const canonicalResponse = await createReviewSession(req);
  // Preserve the legacy route's 200 success contract while forwarding the
  // request body and canonical Location header during the deprecation window.
  const legacyResponse =
    canonicalResponse.status === 201
      ? new Response(canonicalResponse.body, {
          status: 200,
          headers: canonicalResponse.headers,
        })
      : canonicalResponse;
  return deprecatedRouteResponse(legacyResponse, '/api/review-sessions');
}
