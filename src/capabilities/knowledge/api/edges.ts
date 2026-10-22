// Knowledge-edge CRUD. Writes go through the single owner in server/edges.ts;
// relation_type validation comes from the shared schema.

import {
  CreateKnowledgeEdgeBodySchema,
  KnowledgeEdgeQuerySchema,
} from '@/capabilities/knowledge/api/contracts';
import {
  acquireEdgeEndpointLocks,
  withEdgeEndpointLockRetry,
} from '@/capabilities/knowledge/server/edge-topology-write';
import {
  createKnowledgeEdge,
  getKnowledgeEdgeById,
  listKnowledgeEdgesPage,
} from '@/capabilities/knowledge/server/edges';
import { db } from '@/db/client';
import { ApiError, collectionPayload, errorResponse, resourceResponse } from '@/kernel/http';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';
import { wakeHubSyncAfterCommit } from '@/server/boss/hub-sync-wake';

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
      subject: parsed.data.subject,
      includeArchived: parsed.data.include_archived,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor,
    });
    const learnerRows = page.rows.filter(
      (edge) =>
        isLearnerVisibleKnowledgeId(edge.from_knowledge_id) &&
        isLearnerVisibleKnowledgeId(edge.to_knowledge_id),
    );
    const learnerPage = { ...page, rows: learnerRows };
    return Response.json(
      collectionPayload(
        learnerRows,
        { limit: parsed.data.limit, next_cursor: page.next_cursor },
        learnerPage,
      ),
    );
  } catch (err) {
    return errorResponse(err);
  }
}

export async function getEdge(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const edge = await getKnowledgeEdgeById(db, params.id);
    if (
      !edge ||
      !isLearnerVisibleKnowledgeId(edge.from_knowledge_id) ||
      !isLearnerVisibleKnowledgeId(edge.to_knowledge_id)
    ) {
      throw new ApiError('not_found', `knowledge edge ${params.id} not found`, 404);
    }
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
    // Event-sourced: row and generate event share one transaction, actor and timestamp,
    // so the edge folds to its row. Ignore the request's created_by and use the manual
    // user actor, matching what the fold derives.
    const now = new Date();
    const fromId = parsed.data.from_knowledge_id;
    const toId = parsed.data.to_knowledge_id;
    const endpointIds = Array.from(new Set([fromId, toId]));
    // Same locks and topology gate as proposal accept, so a direct call cannot close a
    // prerequisite cycle.
    const id = await withEdgeEndpointLockRetry(
      () =>
        db.transaction(async (tx) => {
          await acquireEdgeEndpointLocks(tx, fromId, toId, endpointIds);
          const edgeId = await createKnowledgeEdge(tx, {
            from_knowledge_id: fromId,
            to_knowledge_id: toId,
            relation_type: parsed.data.relation_type,
            weight: parsed.data.weight,
            reasoning: parsed.data.reasoning ?? null,
            actor_kind: 'user',
            actor_ref: 'self',
            created_at: now,
          });
          return edgeId;
        }),
      {
        uniqueViolationMessage: `edge already exists: ${fromId} --${parsed.data.relation_type}--> ${toId}`,
      },
    );
    // Fire-and-forget wake; the trigger already marked hubs dirty, this just
    // shortcuts recovery. The seam swallows its own errors.
    void wakeHubSyncAfterCommit();
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
