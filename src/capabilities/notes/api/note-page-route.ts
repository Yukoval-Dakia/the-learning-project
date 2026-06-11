// YUK-203 P1 (ADR-0027) — GET /api/notes/[id]: the canonical NoteReader read.
//
// A note(artifact) is a first-class knowledge-labeled entity (ADR-0027); this is
// its single-fetch read aggregator (blocks + labels + verification + version
// history + backlinks + related learning_items + embedded questions). Auth is
// enforced upstream by middleware (x-internal-token); the handler mirrors the
// sibling artifact routes' shape (zod params, 404 on missing, errorResponse).

import { z } from 'zod';

import { loadNotePage } from '@/capabilities/notes/server/note-page';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'note id is required', 400);
    }
    const page = await loadNotePage(db, parsed.data.id);
    if (!page) {
      // Missing, archived, or not a note type → 404 (never a 200 empty shell).
      throw new ApiError('not_found', `note ${parsed.data.id} not found`, 404);
    }
    return Response.json(page);
  } catch (err) {
    return errorResponse(err);
  }
}
