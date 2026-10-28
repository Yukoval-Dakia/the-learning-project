import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { listNoteRefineChanges } from '@/kernel/read-models/note-refine-changes';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
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
