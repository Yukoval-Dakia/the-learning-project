// Submit one slot using its original issuance and server-frozen feedback policy.
// Accepted responses are immutable; only a native effective evaluation settles learning.
// Buffered replies expose receipt identities without grading feedback.

import { db } from '@/db/client';
import { deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { submitLegacyPaperSubmission } from '../server/paper-submission-operation';

export async function createPaperSubmission(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    return Response.json(await submitLegacyPaperSubmission(db, params.id, raw));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const body = (await req
    .clone()
    .json()
    .catch(() => null)) as { session_id?: unknown } | null;
  const successor =
    typeof body?.session_id === 'string' && body.session_id.length > 0
      ? `/api/review-sessions/${body.session_id}/submissions`
      : '/api/review-sessions';
  return deprecatedRouteResponse(await createPaperSubmission(req, params), successor);
}
