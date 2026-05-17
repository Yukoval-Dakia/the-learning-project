// ADR-0013 — eager create review session on /review page mount.

import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { Review } from '@/server/session';

export const runtime = 'nodejs';

export async function POST(): Promise<Response> {
  try {
    const { sessionId } = await Review.startReviewSession(db);
    return Response.json({ session_id: sessionId });
  } catch (err) {
    return errorResponse(err);
  }
}
