// Phase 1c.2 — accept knowledge-edge proposals into knowledge_edge.
//
// Pre-1c.2 the UI tracked accept/reverse/change_type/dismiss decisions in local
// React state only — the proposal stream was effectively dry-run. This route
// closes that loop: a single POST writes a rate event (ADR-0011 RateKnowledgeEdge),
// and for accept-class decisions also inserts the actual knowledge_edge row +
// a chained generate event (ADR-0011 GenerateKnowledgeEdge) inside one txn.
//
// POST /api/knowledge/edges/proposals/[id]
//   body: { decision: 'accept' | 'reverse' | 'change_type' | 'dismiss',
//           new_relation_type?: string,    // required when decision='change_type'
//           user_note?: string }
//   → 200 { rate_event_id, generate_event_id|null, edge_id|null }
//   → 200 { …, idempotent: true } when re-submitting the same decision
//   → 400 validation error (bad decision, missing new_relation_type, etc.)
//   → 404 propose event not found
//   → 409 proposal already decided differently / edge collides with existing row
//
// `id` is the propose event id (the row in `event` with action='propose' and
// subject_kind='knowledge_edge'). Chain: rate.caused_by = propose.id,
// generate.caused_by = propose.id, generate.payload.propose_event_id = propose.id.

import { z } from 'zod';

import { RelationTypeSchema } from '@/core/schema/event/blocks';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { decideKnowledgeEdgeProposal } from '@/server/proposals/actions';

export const runtime = 'nodejs';

const DecisionBody = z.object({
  decision: z.enum(['accept', 'reverse', 'change_type', 'dismiss']),
  new_relation_type: RelationTypeSchema.optional(),
  user_note: z.string().max(2000).optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(req: Request, { params }: RouteParams): Promise<Response> {
  try {
    const { id: proposeEventId } = await params;
    const raw = await req.json().catch(() => null);
    const parsed = DecisionBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { decision, new_relation_type, user_note } = parsed.data;

    if (decision === 'change_type' && !new_relation_type) {
      throw new ApiError('validation_error', 'change_type requires new_relation_type', 400);
    }

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
