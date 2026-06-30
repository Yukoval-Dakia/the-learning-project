// YUK-531 (A5 S4 / PR-5) — candidate misconception veto endpoint.
//
// POST /api/knowledge/misconceptions/[id]/veto
//   id = a per-KC CANDIDATE row id = the pending conjecture proposal event id (the candidate
//   segment substrate; the confirmed segment's id space is disjoint). Dismiss it via the
//   generic dismissAiProposal (a 'conjecture' proposal hits the default branch → writes a
//   rate(dismiss) event + decision signal; idempotent on a non-pending proposal).
//
//   Option A scope (owner-approved): ONLY the candidate segment is live here. The confirmed
//   (RT1 误区) archive is a DEFERRED soft-track backend slice (no live writer + the confirmed
//   segment is empty day-one behind the PR-3 promote flag), so the UI never POSTs here for a
//   confirmed row — it shows an optimistic-only「已纠偏」card instead.
//
//   → 200 dismiss result (idempotent: a non-pending proposal returns { idempotent: true })
//   → 400 missing / blank id
//   → 404 unknown proposal id
//   → 409 already decided as accept (conflict)
//   → 422 the id resolves to a NON-conjecture proposal (endpoint semantic boundary, see below)
//
// Mirrors api/proposal-decide.ts (ParamsSchema + ApiError + errorResponse). No body needed:
// the path id + the implicit dismiss verb fully specify the action (the user's「判错了」).

import { z } from 'zod';

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { dismissAiProposal } from '@/server/proposals/actions';
import { getProposalInboxRow } from '@/server/proposals/inbox';

const ParamsSchema = z.object({ id: z.string().trim().min(1) });

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'misconception candidate id is required', 400);
    }
    const id = parsed.data.id;

    // A (PR-5 review) — ENDPOINT SEMANTIC BOUNDARY. dismissAiProposal dispatches by
    // proposal.kind, so a non-conjecture id (knowledge_edge / variant_question / learning_item
    // / knowledge_node …) would be SILENTLY dismissed AND return a different result shape (e.g.
    // knowledge_edge → { kind:'knowledge_edge', edge_id, … }), violating this endpoint's
    // 「candidate conjecture only」contract. Load the proposal first and reject any other kind
    // with 422; an unknown id stays 404 (mirrors dismissAiProposal's own requireProposal).
    const proposal = await getProposalInboxRow(db, id);
    if (!proposal) {
      throw new ApiError('not_found', `proposal ${id} not found`, 404);
    }
    if (proposal.kind !== 'conjecture') {
      throw new ApiError(
        'unprocessable_entity',
        `proposal ${id} is not a candidate conjecture (kind=${proposal.kind}); this endpoint only vetoes candidate misconceptions`,
        422,
      );
    }

    const result = await dismissAiProposal(db, id);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
