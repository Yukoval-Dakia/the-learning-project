// GET /api/agents/notes — 「AI 观察」只读 feed 的 handler 本体（YUK-311 P1 迁入包）。
// 外壳 app/api/agents/notes/route.ts 仅 re-export；行为与迁移前完全等价
//（原 app/api/agents/notes/route.ts @ YUK-294）。

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { readAllAgentNotes } from '../server/notes';

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
