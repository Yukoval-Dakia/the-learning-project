// Single-fetch read for the NoteReader page.

import { NoteIdParamsSchema } from '@/capabilities/notes/api/contracts';
import { loadNotePage } from '@/capabilities/notes/server/note-page';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = NoteIdParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'note id is required', 400);
    }
    const page = await loadNotePage(db, parsed.data.id);
    if (!page) {
      // Missing, archived, and non-reader types all 404 rather than render an
      // empty shell.
      throw new ApiError('not_found', `note ${parsed.data.id} not found`, 404);
    }
    return Response.json(page);
  } catch (err) {
    return errorResponse(err);
  }
}
