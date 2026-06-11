import { z } from 'zod';

import { db } from '@/db/client';
import {
  listNoteRefineChanges,
  undoNoteRefineApplyEvent,
} from '@/capabilities/notes/server/note-refine-apply';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const UndoBody = z.object({
  event_ids: z.array(z.string().min(1)).min(1).max(25),
});

export async function GET(_req: Request): Promise<Response> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const rows = await listNoteRefineChanges(db, { since, limit: 25 });
    return Response.json({ window_hours: 24, rows });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = UndoBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const results = [];
    for (const applyEventId of parsed.data.event_ids) {
      results.push(await undoNoteRefineApplyEvent(db, { applyEventId }));
    }
    return Response.json({ results });
  } catch (err) {
    return errorResponse(err);
  }
}
