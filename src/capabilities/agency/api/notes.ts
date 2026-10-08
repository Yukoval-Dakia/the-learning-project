// GET /api/agents/notes — learner observation board, mounted by the agency manifest.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { loadAgentNoteBoard } from '../server/note-board-read';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const board = await loadAgentNoteBoard(
      db,
      { limit: url.searchParams.get('limit') ?? undefined },
      new Date(),
    );
    return Response.json(board);
  } catch (err) {
    return errorResponse(err);
  }
}
