// YUK-57 — POST /api/review/sessions/[id]/resume moves a paused review
// session back to started. Used by /today SessionStrip 恢复 button and
// /review?session=<id> URL-param resume on mount.

import { deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { resumeReviewSession } from '../server/session-operations/review-session';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  let response: Response;
  try {
    const { id } = params;
    await resumeReviewSession(id);
    response = Response.json({ ok: true, status: 'started' });
  } catch (err) {
    response = errorResponse(err);
  }
  return deprecatedRouteResponse(response, `/api/review-sessions/${params.id}`);
}
