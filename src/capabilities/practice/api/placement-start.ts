// POST /api/placement/start — cold-start inc-B (YUK-468, PR-2b).
// docs/design/2026-06-20-cold-start-day-one-design.md §2 步骤3 / §5 inc-B.
//
// Starts a bounded placement probe and returns the first question. The probe scope is the
// goal subgraph KC set (goal.scope_knowledge_ids, or an explicit knowledgeIds override).
// Answers are submitted through the EXISTING /api/review/submit with session_id=<this probe>
// (which runs judge + θ̂ update + FSRS — no separate placement submit). The next question +
// termination check are served by /api/placement/[id]/next.
//
// DARK-SHIP: gated on PLACEMENT_PROBE_ENABLED (default false) — while off the entrypoint 404s,
// so no placement session is ever created and the live paths are untouched (the flag's only
// effect). Flipping it on is the cold-start first-session go-live decision.

import {
  ApiError,
  canonicalResourceResponse,
  deprecatedRouteResponse,
  errorResponse,
} from '@/kernel/http';
import { noItemField, placementNoItem } from '../server/placement-advance';
import { startPlacementProbe } from '../server/session-operations/placement-session';
import { CreatePlacementSessionBodySchema } from './placement-contracts';

export async function createPlacementSession(req: Request): Promise<Response> {
  try {
    const result = await startPlacementProbe(async () => {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        throw new ApiError('validation_error', 'request body must be valid JSON', 400);
      }
      const parsed = CreatePlacementSessionBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new ApiError(
          'validation_error',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          400,
        );
      }
      return parsed.data;
    });
    // Keep sourcingNeeded for compatibility. starterSupply distinguishes pending
    // supply from terminal failure; neither outcome completes the placement session.
    return Response.json({
      sessionId: result.sessionId,
      knowledgeIds: result.knowledgeIds,
      question: result.question,
      answeredCount: 0,
      sourcingNeeded: result.question === null,
      starterSupply: result.starterSupply,
      // YUK-1405 — a fresh session has nothing unresolved (field omitted);
      // the typed alternative is present only when no question was served.
      ...noItemField(result.question === null ? placementNoItem(result.starterSupply) : null),
    });
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
