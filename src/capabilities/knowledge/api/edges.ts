// Knowledge-edge CRUD. Writes go through the single owner in server/edges.ts;
// relation_type validation comes from the shared schema.

import { createManualKnowledgeEdge } from '@/capabilities/knowledge/server/edge-create';
import { getKnowledgeEdgeById } from '@/capabilities/knowledge/server/edges';
import { readKnowledgeEdges } from '@/capabilities/knowledge/server/edges-list';
import { db } from '@/db/client';
import { ApiError, errorResponse, resourceResponse } from '@/kernel/http';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const raw: Record<string, string> = {};
    for (const [key, value] of url.searchParams.entries()) raw[key] = value;
    return Response.json(await readKnowledgeEdges(db, raw));
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
    const result = await createManualKnowledgeEdge(db, raw);
    return resourceResponse(result, {
      outcome: 'created',
      location: `/api/knowledge/edges/${encodeURIComponent(result.id)}`,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
