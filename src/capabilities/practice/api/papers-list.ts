// U5 (YUK-203, §4.10 Q8) — GET /api/papers: the 今日/往日 paper list
// aggregation (paper artifacts + linked review session + derived pos/right-
// wrong/gen). The legacy /api/practice route is mounted through a compatibility
// wrapper. Its POST handler remains here only for old clients; canonical clients
// create the session through POST /api/review-sessions.
//
// Handler logic lives in server modules (Review.startReviewSession +
// getPracticeList) so the route module only exports recognized handlers
// (next build / YUK-67).

import { z } from 'zod';

import { getPracticeList } from '@/capabilities/practice/server/practice-read';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createPaperReviewSession } from './paper-session-create';

export async function GET(_req?: Request): Promise<Response> {
  try {
    const result = await getPracticeList(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}

const StartBody = z.object({
  artifact_id: z.string().min(1),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = StartBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'artifact_id is required', 400);
    }
    const { sessionId } = await createPaperReviewSession(parsed.data.artifact_id);
    return Response.json({ session_id: sessionId });
  } catch (err) {
    return errorResponse(err);
  }
}
