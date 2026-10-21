// Single node read: one server-side aggregate replaces the old client-side full
// scans. Read-only; unknown or archived ids are 404.

import { KnowledgeIdParamsSchema } from '@/capabilities/knowledge/api/contracts';
import { loadKnowledgeNodePage } from '@/capabilities/knowledge/server/node-page';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { isLearnerVisibleKnowledgeId } from '@/kernel/read-models/learner-knowledge-visibility';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = KnowledgeIdParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'knowledge id is required', 400);
    }
    if (!isLearnerVisibleKnowledgeId(parsed.data.id)) {
      throw new ApiError('not_found', 'knowledge node not found', 404);
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
