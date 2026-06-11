// YUK-96 P6/C — single knowledge node read endpoint (ADR-0020 §10).
//
// GET /api/knowledge/[id]
//   → 200 KnowledgeNodePage (metadata + mastery + mesh neighbors + primary
//          atomic body_blocks + backlinks + activity timeline)
//   → 404 unknown / archived knowledge id
//
// Replaces the old /knowledge/[id] client page's O(N) `/api/knowledge` full
// snapshot scan + `/api/mistakes?limit=200` scan with one server-side aggregate
// (loadKnowledgeNodePage). Read-only; no write path.

import { z } from 'zod';

import { loadKnowledgeNodePage } from '@/capabilities/knowledge/server/node-page';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'knowledge id is required', 400);
    }
    const page = await loadKnowledgeNodePage(db, parsed.data.id);
    if (!page) {
      throw new ApiError('not_found', `knowledge ${parsed.data.id} not found`, 404);
    }
    return Response.json(page);
  } catch (err) {
    return errorResponse(err);
  }
}
