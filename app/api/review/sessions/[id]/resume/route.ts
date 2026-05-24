// YUK-57 — POST /api/review/sessions/[id]/resume moves a paused review
// session back to started. Used by /today SessionStrip 恢复 button and
// /review?session=<id> URL-param resume on mount.

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
    await Review.resumeReviewSession(db, id);
    return Response.json({ ok: true, status: 'started' });
  } catch (err) {
    return errorResponse(err);
  }
}
