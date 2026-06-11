// Phase 1c.1 Step 6 — knowledge_edge CRUD (ADR-0010 mesh).
//
// GET  /api/knowledge/edges?from=K&to=K&relation_type=T
//   → { rows: KnowledgeEdgeRow[] }
//
// POST /api/knowledge/edges
//   body: { from_knowledge_id, to_knowledge_id, relation_type, weight?,
//           created_by?, reasoning? }
//   → 201 { id }
//   → 400 invalid body (bad relation_type, missing required field, etc.)
//   → 404 unknown / archived from_knowledge_id or to_knowledge_id
//   → 409 duplicate per UNIQUE(from, to, relation_type) (ADR-0010)
//
// Writes go through `src/server/knowledge/edges.ts` (single-owner per ADR-0005).
// `relation_type` lock comes from Lane B `RelationTypeSchema`.

import { z } from 'zod';

import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createKnowledgeEdge, listKnowledgeEdges } from '@/capabilities/knowledge/server/edges';

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

const BodySchema = z.object({
  from_knowledge_id: z.string().min(1, 'from_knowledge_id is required'),
  to_knowledge_id: z.string().min(1, 'to_knowledge_id is required'),
  relation_type: RelationTypeSchema,
  weight: z.number().min(0).max(1).optional(),
  created_by: z.unknown().optional(),
  reasoning: z.string().nullable().optional(),
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

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const id = await createKnowledgeEdge(db, {
      from_knowledge_id: parsed.data.from_knowledge_id,
      to_knowledge_id: parsed.data.to_knowledge_id,
      relation_type: parsed.data.relation_type,
      weight: parsed.data.weight,
      created_by: parsed.data.created_by,
      reasoning: parsed.data.reasoning ?? null,
    });
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
