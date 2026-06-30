// YUK-531 (A5 S4 / ADR-0036 RT1) — per-KC misconception read endpoint.
//
// GET /api/knowledge/[id]/misconceptions
//   → 200 { rows: MisconceptionRow[] } — the「指向此点的误区」funnel: live confirmed
//          误区 (caused_by edge join) + per-KC pending conjecture candidates. Read-only;
//          no write path. Empty KC → { rows: [] } (honest empty, never zero-filled).
//   → 400 missing / blank id.

import { z } from 'zod';

import { loadMisconceptionsForKc } from '@/capabilities/knowledge/server/misconception-read';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'knowledge id is required', 400);
    }
    const rows = await loadMisconceptionsForKc(db, parsed.data.id);
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
