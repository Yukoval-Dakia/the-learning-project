// U5 (YUK-203, §4.10 Q8) — GET /api/papers: the 今日/往日 paper list
// aggregation (paper artifacts + linked review session + derived pos/right-
// wrong/gen). The legacy /api/practice route is mounted through a compatibility
// wrapper. Its POST handler remains here only for old clients; canonical clients
// create the session through POST /api/review-sessions.
//
// Handler logic lives in server modules (Review.startReviewSession +
// getPracticeList) so the route module only exports recognized handlers
// (next build / YUK-67).

import { getPracticeList } from '@/capabilities/practice/server/practice-read';
import { db } from '@/db/client';
import { ApiError, collectionPayload, errorResponse } from '@/kernel/http';
import { CreateLegacyPaperReviewSessionBodySchema } from './paper-contracts';
import { createPaperReviewSession } from './paper-session-create';

function parseLimit(value: string | null): number {
  if (value === null) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ApiError('validation_error', `invalid limit: ${value}`, 400);
  }
  return Math.min(parsed, 200);
}

export async function GET(req?: Request): Promise<Response> {
  try {
    const url = new URL(req?.url ?? 'http://localhost/api/papers');
    const limit = parseLimit(url.searchParams.get('limit'));
    const result = await getPracticeList(db, {
      limit,
      cursor: url.searchParams.get('cursor') ?? undefined,
    });
    return Response.json(
      collectionPayload(result.papers, { limit, next_cursor: result.next_cursor }, result),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = CreateLegacyPaperReviewSessionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'artifact_id is required', 400);
    }
    const { sessionId } = await createPaperReviewSession(parsed.data.artifact_id);
    return Response.json({ session_id: sessionId });
  } catch (err) {
    return errorResponse(err);
  }
}
