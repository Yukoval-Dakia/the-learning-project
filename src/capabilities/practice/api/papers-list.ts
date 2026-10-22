// GET /api/papers: 今日/往日 paper list aggregation (paper artifacts + linked
// review session + derived position/right/wrong counts). The legacy
// /api/practice route is mounted through a compatibility wrapper.
//
// The POST handler remains here only for old clients; canonical clients create
// the session through POST /api/review-sessions. Handler logic lives in server
// modules so this file stays a thin route.

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readPaperList } from '../server/papers-list';
import { CreateLegacyPaperReviewSessionBodySchema } from './paper-contracts';
import { createPaperReviewSession } from './paper-session-create';

export async function GET(req?: Request): Promise<Response> {
  try {
    const url = new URL(req?.url ?? 'http://localhost/api/papers');
    return Response.json(
      await readPaperList(db, {
        limit: url.searchParams.get('limit'),
        cursor: url.searchParams.get('cursor'),
      }),
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
