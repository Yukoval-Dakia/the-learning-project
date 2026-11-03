import { listArtifactAiChanges } from '@/capabilities/notes/server/ai-change-request';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await listArtifactAiChanges(db, params.id));
  } catch (err) {
    return errorResponse(err);
  }
}
