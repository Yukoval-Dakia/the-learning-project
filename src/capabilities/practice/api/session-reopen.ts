// YUK-63 — POST /api/review/sessions/[id]/reopen moves an abandoned review
// session back to started. Used by /learning-sessions Resume and by
// /review?session=<id> when the target session was orphan-cron abandoned.

import { deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { reopenReviewSession } from '../server/session-operations/review-session';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  let response: Response;
  try {
    const { id } = params;
    await reopenReviewSession(id);
    response = Response.json({ ok: true, status: 'started' });
  } catch (err) {
    response = errorResponse(err);
  }
  return deprecatedRouteResponse(response, `/api/review-sessions/${params.id}`);
}
