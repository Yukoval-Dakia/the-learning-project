// POST /api/placement/[id]/next.
//
// After the client submits an answer through /api/review/submit (with session_id=<this probe>,
// which already ran judge + θ̂ update), this endpoint (1) evaluates termination over the
// answers so far and (2) returns the next question, or signals the probe is done.
//
// Answered/served are derived from the probe's own event chain (events with this session_id),
// so this endpoint never double-counts or repeats — it reuses the answer trail the shared
// submit path writes. Termination = hard count cap (8/subject) + optional θ SE
// convergence (placement-termination.ts). Next question = selectNextPlacementItem over the
// goal subgraph, excluding everything already served.
//
// CONCURRENCY: the whole body runs in a transaction that row-locks the
// placement session inside runPlacementAdvanceTx (SELECT … FOR UPDATE). Without it, two
// concurrent POST /next on the same probe could both pass the started check, read the same
// answeredIds, and return the SAME question. The lock serializes them: the second POST
// blocks until the first commits, then sees the updated answer trail.
//
// SCOPE: the probe's KC scope is read server-side from the session
// (scope_knowledge_ids, persisted at start) — NOT trusted from the client body. The client
// param survives only as an optional override (e.g. inc-E prereq-walk widening); when omitted,
// the persisted scope is authoritative.
//
// The lock + advance live in server/placement-advance.ts (shared with the
// held-release route). This handler stays a thin adapter: body parse → advance → attach
// starterSupply + the typed no_item alternative.

import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { selectNextPlacementQuestion } from '../server/session-operations/placement-next';

export async function createPlacementQuestionSelection(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  try {
    const { id } = params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
    return Response.json(await selectNextPlacementQuestion(db, id, raw));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  const response = await createPlacementQuestionSelection(req, params);
  return deprecatedRouteResponse(
    response,
    `/api/placement-sessions/${params.id}/question-selections`,
  );
}
