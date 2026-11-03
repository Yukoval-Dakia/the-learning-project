import { undoArtifactAiChange } from '@/capabilities/notes/server/ai-change-request';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await undoArtifactAiChange(db, params.id, params.eventId));
  } catch (err) {
    return errorResponse(err);
  }
}
