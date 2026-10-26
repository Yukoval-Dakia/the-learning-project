import { ProposalDecisionInput } from '@/core/schema/proposal';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { wakeHubSyncAfterCommit } from '@/server/boss/hub-sync-wake';
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
    // A committed decision points at an immutable event: honest Location, plus a
    // best-effort hub-sync wake after commit (accepting a KC/edge proposal mutates
    // topology; the trigger already dirtied every live hub). Fire-and-forget keeps
    // the response independent of pg-boss latency; the seam swallows its errors.
    //
    // A soft-stale block_merge accept commits nothing, so it returns 200
    // non-created with no Location header and skips the wake.
    if (resource.decision_event_id === null) {
      return Response.json(resource, { status: 200 });
    }
    void wakeHubSyncAfterCommit();
    const headers = new Headers({
      Location: `/api/events/${encodeURIComponent(resource.decision_event_id)}`,
    });
    return Response.json(resource, { status: resource.created ? 201 : 200, headers });
  } catch (err) {
    return errorResponse(err);
  }
}
