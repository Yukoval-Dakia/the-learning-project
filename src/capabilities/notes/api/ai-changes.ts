import { db } from '@/db/client';
import { listNoteRefineChanges } from '@/capabilities/notes/server/note-refine-apply';
import { ApiError, errorResponse } from '@/server/http/errors';

export async function GET(_req: Request, params: Record<string, string>,): Promise<Response> {
  try {
    const { id: artifactId } = params;
    if (!artifactId) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    const rows = await listNoteRefineChanges(db, { artifactId, limit: 50 });
    return Response.json({ artifact_id: artifactId, rows });
  } catch (err) {
    return errorResponse(err);
  }
}
