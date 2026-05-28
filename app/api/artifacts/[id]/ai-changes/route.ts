import { db } from '@/db/client';
import { listNoteRefineChanges } from '@/server/artifacts/note-refine-apply';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: artifactId } = await params;
    if (!artifactId) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    const rows = await listNoteRefineChanges(db, { artifactId, limit: 50 });
    return Response.json({ artifact_id: artifactId, rows });
  } catch (err) {
    return errorResponse(err);
  }
}
