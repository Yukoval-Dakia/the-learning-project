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
    // YUK-1404 — a committed decision points at a real immutable event: honest
    // Location + best-effort hub-sync wake AFTER the decision commits (an
    // accepted KC/edge proposal is a topology mutation; the trigger already
    // dirtied every live hub durably). Fire-and-forget (`void`, W1) — never
    // binds this response to pg-boss availability/latency; the seam
    // double-swallows its own errors.
    //
    // The soft-stale block_merge accept committed NOTHING (no rate event, no
    // signal, no status change): serve it 200 non-created with NO Location
    // header (never /api/events/null) and skip the wake — there is no effect
    // to sync.
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
