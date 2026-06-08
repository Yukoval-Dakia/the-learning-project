// GET /api/agents/notes — unfiltered agent-notes feed for the read-only "AI 观察"
// board (YUK-294). Reads every un-expired cross-agent observation (no for_agent
// containment); the board is a pure spectator surface with no write path.

import { z } from 'zod';

import { db } from '@/db/client';
import { readAllAgentNotes } from '@/server/agents/notes';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const parsed = QuerySchema.safeParse({
      limit: url.searchParams.get('limit') ?? undefined,
    });
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const rows = await readAllAgentNotes(db, { now: new Date(), limit: parsed.data.limit });
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
