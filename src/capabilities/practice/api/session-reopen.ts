// YUK-63 — POST /api/review/sessions/[id]/reopen moves an abandoned review
// session back to started. Used by /learning-sessions Resume and by
// /review?session=<id> when the target session was orphan-cron abandoned.

import { db } from '@/db/client';
import { deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { Review } from '@/server/session';
import { withFrozenPaperReopen } from '../server/assessment/paper-session-transition';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  let response: Response;
  try {
    const { id } = params;
    await withFrozenPaperReopen(db, id, (tx) => Review.reopenAbandonedReviewSession(tx, id));
    response = Response.json({ ok: true, status: 'started' });
  } catch (err) {
    response = errorResponse(err);
  }
  return deprecatedRouteResponse(response, `/api/review-sessions/${params.id}`);
}
