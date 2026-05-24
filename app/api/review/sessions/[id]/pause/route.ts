// YUK-57 — POST /api/review/sessions/[id]/pause moves a started review
// session to paused. Mirrors end/route.ts body-parsing so it stays
// sendBeacon-friendly (text/plain Blob body works just like JSON).

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
    await Review.pauseReviewSession(db, id);
    return Response.json({ ok: true, status: 'paused' });
  } catch (err) {
    return errorResponse(err);
  }
}
