// Decide a knowledge-edge proposal. Accept-class decisions write a rate event and,
// in the same transaction, the edge row and its chained generate event.
//
// `id` is the propose event id. Repeating the same decision is idempotent; a
// different decision or a unique collision is 409.

import { LegacyKnowledgeEdgeDecisionBodySchema } from '@/capabilities/knowledge/api/contracts';
import { decideKnowledgeEdgeProposal } from '@/capabilities/knowledge/public';
import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await handleLegacyEdgeDecision(req, params);
  const successor = `/api/proposals/${encodeURIComponent(params.id ?? '')}/decisions`;
  return deprecatedRouteResponse(response, successor);
}

async function handleLegacyEdgeDecision(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id: proposeEventId } = params;
    const raw = await req.json().catch(() => null);
    const parsed = LegacyKnowledgeEdgeDecisionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { decision, new_relation_type, user_note } = parsed.data;

    const result = await decideKnowledgeEdgeProposal(db, proposeEventId, {
      decision,
      new_relation_type,
      user_note,
    });
    const { kind: _kind, ...legacyBody } = result;
    return Response.json(legacyBody);
  } catch (err) {
    return errorResponse(err);
  }
}
