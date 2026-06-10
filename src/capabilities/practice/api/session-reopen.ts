// YUK-63 — POST /api/review/sessions/[id]/reopen moves an abandoned review
// session back to started. Used by /learning-sessions Resume and by
// /review?session=<id> when the target session was orphan-cron abandoned.

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { Review } from '@/server/session';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = params;
    await Review.reopenAbandonedReviewSession(db, id);
    return Response.json({ ok: true, status: 'started' });
  } catch (err) {
    return errorResponse(err);
  }
}
