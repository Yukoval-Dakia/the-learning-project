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

import { createId } from '@paralleldrive/cuid2';

import {
  CreateKnowledgeEdgeBodySchema,
  KnowledgeEdgeQuerySchema,
} from '@/capabilities/knowledge/api/contracts';
import {
  createKnowledgeEdge,
  getKnowledgeEdgeById,
  listKnowledgeEdgesPage,
} from '@/capabilities/knowledge/server/edges';
import { db } from '@/db/client';
import { collectionPayload, resourceResponse } from '@/kernel/http';
import { writeEvent } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) raw[key] = value;
    const parsed = KnowledgeEdgeQuerySchema.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const page = await listKnowledgeEdgesPage(db, {
      from: parsed.data.from,
      to: parsed.data.to,
      relation_type: parsed.data.relation_type,
      includeArchived: parsed.data.include_archived,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    return Response.json(
      collectionPayload(
        page.rows,
        { limit: parsed.data.limit, next_cursor: page.next_cursor },
        page,
      ),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function getEdge(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const edge = await getKnowledgeEdgeById(db, params.id);
    if (!edge) throw new ApiError('not_found', `knowledge edge ${params.id} not found`, 404);
    return Response.json(edge);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = CreateKnowledgeEdgeBodySchema.safeParse(raw);
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
    return resourceResponse(
      { id },
      {
        outcome: 'created',
        location: `/api/knowledge/edges/${encodeURIComponent(id)}`,
      },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
