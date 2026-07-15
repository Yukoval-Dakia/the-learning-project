// M5-T3 (YUK-321) — GET /api/copilot/turns?limit=20（重放 last-N，等价平移）。

import { getRecentCopilotTurns } from '@/capabilities/copilot/server/turns';
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { CopilotTurnsQuerySchema } from './contracts';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw = url.searchParams.get('limit');
    const query = CopilotTurnsQuerySchema.parse({ limit: raw ?? undefined });
    const limit = query.limit === undefined ? undefined : Number.parseInt(query.limit, 10);
    const turns = await getRecentCopilotTurns(db, { limit });
    return Response.json({ turns });
  } catch (err) {
    return errorResponse(err);
  }
}
