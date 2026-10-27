// Recent AI note changes across all artifacts; undo is per event.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { listNoteRefineChanges } from '@/kernel/read-models/note-refine-changes';

export async function GET(): Promise<Response> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const rows = await listNoteRefineChanges(db, { since, limit: 25 });
    return Response.json({ window_hours: 24, rows });
  } catch (err) {
    return errorResponse(err);
  }
}
