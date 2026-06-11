import { db } from '@/db/client';
import {
  listNoteRefineChanges,
  undoNoteRefineApplyEvent,
} from '@/capabilities/notes/server/note-refine-apply';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

interface RouteParams {
  params: Promise<{ id: string; eventId: string }>;
}

export async function POST(_req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: artifactId, eventId } = await params;
    if (!artifactId) {
      throw new ApiError('validation_error', 'artifact id is required', 400);
    }
    if (!eventId) {
      throw new ApiError('validation_error', 'event id is required', 400);
    }
    const changes = await listNoteRefineChanges(db, { artifactId, limit: 200 });
    if (!changes.some((row) => row.event_id === eventId)) {
      throw new ApiError(
        'not_found',
        `note refine apply event ${eventId} was not found for artifact ${artifactId}`,
        404,
      );
    }
    const result = await undoNoteRefineApplyEvent(db, { applyEventId: eventId });
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
