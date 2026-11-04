// Starts a bounded placement probe and returns the first question. The probe scope is the
// goal subgraph KC set (goal.scope_knowledge_ids, or an explicit knowledgeIds override).
// Answers are submitted through the EXISTING /api/review/submit with session_id=<this probe>
// (which runs judge + θ̂ update + FSRS — no separate placement submit). The next question +
// termination check are served by /api/placement/[id]/next.
//
// PLACEMENT_PROBE_ENABLED (default on; switch it off in /admin/config) makes the entrypoint 404
// and creates no placement session.

import { canonicalResourceResponse, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { startPlacementProbe } from '../server/session-operations/placement-session';

export async function createPlacementSession(req: Request): Promise<Response> {
  try {
    return Response.json(await startPlacementProbe(() => req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function createPlacementSessionResource(req: Request): Promise<Response> {
  return canonicalResourceResponse(await createPlacementSession(req), {
    outcome: 'created',
    location: (body) =>
      `/api/placement-sessions/${encodeURIComponent((body as { sessionId: string }).sessionId)}`,
  });
}

export async function POST(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await createPlacementSession(req), '/api/placement-sessions');
}
