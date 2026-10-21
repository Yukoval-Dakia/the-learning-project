// Veto a candidate misconception, identified by its pending conjecture proposal id.
//
// Only the candidate segment is live here; confirmed misconceptions have no archive
// path yet. Non-conjecture ids get 422, unknown ids 404, and an already-accepted
// proposal 409. Dismissal is idempotent and needs no body.

import { KnowledgeIdParamsSchema } from '@/capabilities/knowledge/api/contracts';
import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { getProposalInboxRow } from '@/kernel/proposals/inbox';
import { dismissAiProposal } from '@/server/proposals/actions';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  const response = await handleLegacyVeto(params);
  const successor = `/api/proposals/${encodeURIComponent(params.id ?? '')}/decisions`;
  return deprecatedRouteResponse(response, successor);
}

async function handleLegacyVeto(params: Record<string, string>): Promise<Response> {
  try {
    const parsed = KnowledgeIdParamsSchema.safeParse(params);
    if (!parsed.success) {
      throw new ApiError('validation_error', 'misconception candidate id is required', 400);
    }
    const id = parsed.data.id;

    // dismissAiProposal dispatches by kind, so a non-conjecture id would be dismissed
    // and return a different shape. Enforce this endpoint's conjecture-only contract.
    const proposal = await getProposalInboxRow(db, id);
    if (!proposal) {
      throw new ApiError('not_found', `proposal ${id} not found`, 404);
    }
    if (proposal.kind !== 'conjecture') {
      throw new ApiError(
        'unprocessable_entity',
        `proposal ${id} is not a candidate conjecture; this endpoint only vetoes candidate misconceptions`,
        422,
      );
    }

    const result = await dismissAiProposal(db, id);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
