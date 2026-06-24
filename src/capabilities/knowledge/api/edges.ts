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

import { createId } from '@paralleldrive/cuid2';

import { createKnowledgeEdge, listKnowledgeEdges } from '@/capabilities/knowledge/server/edges';
import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { db } from '@/db/client';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';

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
  // created_by is no longer accepted from the request — a manual edge create is fixed to the
  // {user, self} actor so the stored created_by matches the fold (YUK-471). Any client-sent
  // created_by is ignored (Zod strips unknown keys).
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
    // YUK-471 BYPASS-2 fence — a manual edge create must be EVENT-SOURCED: write the edge row AND
    // a `generate`(create) event in ONE tx, with the SAME actor + created_at, so the edge folds ==
    // its row (the projection SoT). Without the event a POST-created edge would have no fold source
    // → post-flip it diverges / is dropped on a rebuild. The request's loose `created_by` is
    // intentionally NOT used: created_by is fixed to the manual-user actor {user, self} so the row
    // matches the fold (which derives created_by from the event envelope), not a free-form string.
    const now = new Date();
    const id = await db.transaction(async (tx) => {
      const edgeId = await createKnowledgeEdge(tx, {
        from_knowledge_id: parsed.data.from_knowledge_id,
        to_knowledge_id: parsed.data.to_knowledge_id,
        relation_type: parsed.data.relation_type,
        weight: parsed.data.weight,
        reasoning: parsed.data.reasoning ?? null,
        actor_kind: 'user',
        actor_ref: 'self',
        created_at: now,
      });
      await writeEvent(tx, {
        id: createId(),
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'generate',
        subject_kind: 'knowledge_edge',
        subject_id: edgeId,
        outcome: 'success',
        payload: {
          edge_op: 'create',
          from_knowledge_id: parsed.data.from_knowledge_id,
          to_knowledge_id: parsed.data.to_knowledge_id,
          relation_type: parsed.data.relation_type,
          weight: parsed.data.weight ?? 1,
          reasoning: parsed.data.reasoning ?? null,
        },
        created_at: now,
      });
      return edgeId;
    });
    return Response.json({ id }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
