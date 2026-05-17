// Phase 1c.2 — DELETE /api/study-log/[id] (hard delete; StudyLog is user data
// only, no event-stream linkage that needs preserving).

import { eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { study_log } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

type RouteParams = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id } = await params;
    const result = await db
      .delete(study_log)
      .where(eq(study_log.id, id))
      .returning({ id: study_log.id });
    if (result.length === 0) {
      throw new ApiError('not_found', `study_log ${id} not found`, 404);
    }
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
