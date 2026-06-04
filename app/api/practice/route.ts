// U5 (YUK-203, §4.10 Q8) — GET /api/practice: the 今日/往日 practice list
// aggregation (paper artifacts + linked review session + derived pos/right-
// wrong/gen). POST /api/practice: start a review session bound to a paper
// artifact (the answering page calls this on mount).
//
// Handler logic lives in server modules (Review.startReviewSession +
// getPracticeList) so the route module only exports recognized handlers
// (next build / YUK-67).

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getPracticeList } from '@/server/review/practice-read';
import { Review } from '@/server/session';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
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
    const { sessionId } = await Review.startReviewSession(db, {
      artifactId: parsed.data.artifact_id,
    });
    return Response.json({ session_id: sessionId });
  } catch (err) {
    return errorResponse(err);
  }
}
