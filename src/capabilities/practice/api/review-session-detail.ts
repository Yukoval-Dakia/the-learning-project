import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const rows = await db
      .select({
        id: learning_session.id,
        type: learning_session.type,
        status: learning_session.status,
        paper_id: learning_session.artifact_id,
        started_at: learning_session.started_at,
        ended_at: learning_session.ended_at,
        updated_at: learning_session.updated_at,
      })
      .from(learning_session)
      .where(and(eq(learning_session.id, params.id), eq(learning_session.type, 'review')))
      .limit(1);
    const session = rows[0];
    if (!session) {
      throw new ApiError('not_found', `review session ${params.id} not found`, 404);
    }
    return Response.json(session);
  } catch (err) {
    return errorResponse(err);
  }
}
