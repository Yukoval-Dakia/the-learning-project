import { ProposalDecisionInput } from '@/core/schema/proposal';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { createProposalDecision } from '@/server/proposals/decision-resource';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = params.id?.trim();
    if (!id) {
      throw new ApiError('validation_error', 'proposal id is required', 400);
    }
    const raw = await req.json().catch(() => ({}));
    const parsed = ProposalDecisionInput.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
        400,
      );
    }

    const resource = await createProposalDecision(db, id, parsed.data);
    const headers = new Headers({
      Location: `/api/events/${encodeURIComponent(resource.decision_event_id)}`,
    });
    return Response.json(resource, { status: resource.created ? 201 : 200, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
