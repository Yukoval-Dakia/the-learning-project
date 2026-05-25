// YUK-63 — POST /api/review/sessions/[id]/reopen moves an abandoned review
// session back to started. Used by /learning-sessions Resume and by
// /review?session=<id> when the target session was orphan-cron abandoned.

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { Review } from '@/server/session';

export const runtime = 'nodejs';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id } = await params;
    await Review.reopenAbandonedReviewSession(db, id);
    return Response.json({ ok: true, status: 'started' });
  } catch (err) {
    return errorResponse(err);
  }
}
