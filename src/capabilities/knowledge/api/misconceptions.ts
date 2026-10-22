// Per-KC misconception funnel: live confirmed rows plus pending candidates.
// Read-only; an empty KC returns an empty list, never a placeholder.

import { KnowledgeIdParamsSchema } from '@/capabilities/knowledge/api/contracts';
import { loadMisconceptionsForKc } from '@/capabilities/knowledge/server/misconception-read';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = KnowledgeIdParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'knowledge id is required', 400);
    }
    const rows = await loadMisconceptionsForKc(db, parsed.data.id);
    return Response.json({ rows });
  } catch (err) {
    return errorResponse(err);
  }
}
