import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';

/** GET /api/ingestion-sessions/:id — readable target for creation Location headers. */
export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const [session] = await db
      .select({
        id: learning_session.id,
        status: learning_session.status,
        entrypoint: learning_session.entrypoint,
        source_document_id: learning_session.source_document_id,
        source_asset_ids: learning_session.source_asset_ids,
        warnings: learning_session.warnings,
        error_message: learning_session.error_message,
        created_at: learning_session.created_at,
        updated_at: learning_session.updated_at,
      })
      .from(learning_session)
      .where(and(eq(learning_session.id, params.id), eq(learning_session.type, 'ingestion')))
      .limit(1);

    if (!session) {
      throw new ApiError('not_found', 'ingestion session not found', 404);
    }

    return Response.json({
      session: {
        ...session,
        created_at: session.created_at.toISOString(),
        updated_at: session.updated_at.toISOString(),
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
