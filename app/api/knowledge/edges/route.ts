// Phase 1c.1 Step 6 — knowledge_edge CRUD (ADR-0010 mesh).
//
// GET  /api/knowledge/edges?from=K&to=K&relation_type=T
//   → { rows: KnowledgeEdgeRow[] }
//
// POST handler is added in substep 6.E. Writes go through
// `src/server/knowledge/edges.ts` (single-owner per ADR-0005).

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { listKnowledgeEdges } from '@/server/knowledge/edges';

export const runtime = 'nodejs';

const QuerySchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  relation_type: z.string().min(1).optional(),
  include_archived: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) raw[key] = value;
    const parsed = QuerySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const rows = await listKnowledgeEdges(db, {
      from: parsed.data.from,
      to: parsed.data.to,
      relation_type: parsed.data.relation_type,
      includeArchived: parsed.data.include_archived,
    });
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
