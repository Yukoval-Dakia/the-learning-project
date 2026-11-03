// Recent AI note changes across all artifacts; undo is per event.

import { readRecentAiChanges } from '@/capabilities/notes/server/ai-change-request';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await readRecentAiChanges(db));
  } catch (err) {
    return errorResponse(err);
  }
}
