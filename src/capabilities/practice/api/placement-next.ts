// POST /api/placement/[id]/next — cold-start inc-B (YUK-468, PR-2b).
//
// After the client submits an answer through /api/review/submit (with session_id=<this probe>,
// which already ran judge + θ̂ update), this endpoint (1) evaluates termination over the
// answers so far and (2) returns the next question, or signals the probe is done.
//
// Answered/served are derived from the probe's own event chain (events with this session_id),
// so this endpoint never double-counts or repeats — it reuses the answer trail the shared
// submit path writes. Termination = hard count cap (§6 Q1: 8/subject) + optional θ SE
// convergence (placement-termination.ts). Next question = selectNextPlacementItem over the
// goal subgraph, excluding everything already served.
//
// CONCURRENCY (YUK-470 part 1): the whole body runs in a transaction that row-locks the
// placement session (loadPlacementSessionForUpdate → SELECT … FOR UPDATE). Without it, two
// concurrent POST /next on the same probe could both pass the started check, read the same
// answeredIds, and return the SAME question (a plain SELECT gives no serialization). The lock
// serializes them: the second POST blocks until the first commits, then sees the updated
// answer trail. Mirrors review.ts's FOR UPDATE locking idiom.
//
// SCOPE (YUK-470 part 2): the probe's KC scope is read server-side from the session
// (scope_knowledge_ids, persisted at start) — NOT trusted from the client body. The client
// param survives only as an optional override (e.g. inc-E prereq-walk widening); when omitted,
// the persisted scope is authoritative.

import { db } from '@/db/client';
import { ApiError, deprecatedRouteResponse, errorResponse } from '@/kernel/http';
import { getMasteryState } from '@/server/mastery/state';
import { loadPlacementSessionForUpdate } from '@/server/session/placement';
import {
  ensurePlacementAssessment,
  placementAssessmentProgress,
} from '../server/placement-assessment';
import { resolveLeaningPreferenceKcs } from '../server/placement-select';
import {
  PLACEMENT_DEFAULT_CAP,
  capForPace,
  evaluatePlacementTermination,
} from '../server/placement-termination';
import { readPlacementStarterOutcomes } from '../server/question-supply/placement-starter-outcome-reader';
import { CreatePlacementQuestionSelectionBodySchema } from './placement-contracts';

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
    const parsed = CreatePlacementQuestionSelectionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { knowledgeIds: clientScopeOverride, cap, seThreshold } = parsed.data;

    // Run the entire read-select cycle inside one transaction that row-locks the probe session.
    // The lock serializes concurrent POST /next on the same probe (YUK-470 part 1): without it
    // both could pass the started check, read the same answeredIds, and serve the same question.
    const result = await db.transaction(async (tx) => {
      // FOR UPDATE-lock the session + read its status AND server-side scope. A second concurrent
      // /next blocks here until the first tx commits, then re-reads under the lock.
      const session = await loadPlacementSessionForUpdate(tx, id);
      if (!session) {
        throw new ApiError('not_found', `placement session ${id} not found`, 404);
      }
      if (session.status !== 'started') {
        throw new ApiError(
          'conflict',
          `placement session ${id} is ${session.status}, not started`,
          409,
        );
      }

      // Scope is server-side authoritative (YUK-470 part 2): persisted at /start
      // (scope_knowledge_ids). The client param is only an optional override; when omitted, the
      // persisted scope wins — the route no longer trusts the client body for scope.
      const knowledgeIds = clientScopeOverride ?? session.scopeKnowledgeIds ?? [];
      if (knowledgeIds.length === 0) {
        // No server-side scope and no override — a probe started before scope was persisted, or
        // a malformed call. Surface a clear error rather than silently selecting over nothing.
        throw new ApiError(
          'validation_error',
          `placement session ${id} has no scope (no persisted scope_knowledge_ids and no knowledgeIds override)`,
          400,
        );
      }

      const progress = await placementAssessmentProgress(tx, id);
      const { answeredIds, answeredCount } = progress;
      if (progress.outstanding) {
        return {
          done: false as const,
          question: progress.outstanding,
          answeredCount,
          sourcingNeeded: false,
        };
      }

      // Per-KC θ precision (cold KC with no mastery_state row → precision 1, the weak-prior cold
      // value the engine uses). Feeds the SE-convergence early stop. Fan out the independent
      // single-row reads concurrently (OCR major — avoid the N+1 serial await; same Promise.all
      // pattern as mastery-progress-signal.ts).
      const masteryStates = await Promise.all(knowledgeIds.map((kc) => getMasteryState(tx, kc)));
      const perKcPrecision = masteryStates.map((ms) => ms?.theta_precision ?? 1);

      const termination = evaluatePlacementTermination({
        answeredCount,
        // YUK-480 — an explicit client `cap` overrides the pace-derived cap (capForPace; NULL pace →
        // PLACEMENT_DEFAULT_CAP, byte-identical to the pre-YUK-480 default), but PLACEMENT_DEFAULT_CAP
        // is a hard server ceiling: a client cap ABOVE it is clamped down (YUK-452 review — the
        // Math.min means the client cap only "wins" up to that ceiling). Server-authoritative,
        // mirroring scope.
        cap: Math.min(cap ?? capForPace(session.pace), PLACEMENT_DEFAULT_CAP),
        perKcPrecision,
        seThreshold: seThreshold ?? null,
      });
      if (termination.shouldStop) {
        // Probe is done — the client closes it via /api/placement/[id]/end (complete).
        return { done: true as const, reason: termination.reason, answeredCount };
      }

      // YUK-480 — re-resolve the persisted leanings into the preferred KC set (fresh resolve
      // picks up newly-bridged KCs). Resolved on the top-level `db`: it's an INDEPENDENT
      // knowledge-table read (subject effective-domain axis), NOT part of this probe's session-
      // lock serialization — the locked session row (session.leanings) is already in hand. Empty
      // → byte-identical to the no-preference selection. Ordering-only; never feeds θ̂/p(L).
      const preferKnowledgeIds = await resolveLeaningPreferenceKcs(db, session.leanings);
      const next = await ensurePlacementAssessment(
        tx,
        id,
        {
          knowledgeIds,
          excludeQuestionIds: answeredIds,
          preferKnowledgeIds,
        },
        progress,
      );
      return {
        done: false as const,
        question: next,
        answeredCount,
        sourcingNeeded: next === null,
      };
    });

    const starterSupply = await db.transaction((tx) => readPlacementStarterOutcomes(tx, id), {
      isolationLevel: 'repeatable read',
      accessMode: 'read only',
    });
    return Response.json({ ...result, starterSupply });
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
