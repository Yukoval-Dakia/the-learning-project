import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { commitProposalDecisionRequest } from '@/server/proposals/decision-resource';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const raw = await req.json().catch(() => ({}));
    const resource = await commitProposalDecisionRequest(db, params.id, raw);
    // A committed decision points at an immutable event: honest Location. A
    // soft-stale block_merge accept commits nothing, so it returns 200
    // non-created with no Location header.
    if (resource.decision_event_id === null) {
      return Response.json(resource, { status: 200 });
    }
    const headers = new Headers({
      Location: `/api/events/${encodeURIComponent(resource.decision_event_id)}`,
    });
    return Response.json(resource, { status: resource.created ? 201 : 200, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
