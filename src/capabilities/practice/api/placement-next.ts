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

import { z } from 'zod';

import { db } from '@/db/client';
import { event } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getMasteryState } from '@/server/mastery/state';
import { loadPlacementSessionForUpdate } from '@/server/session/placement';
import { and, eq, inArray } from 'drizzle-orm';
import { resolveLeaningPreferenceKcs, selectNextPlacementItem } from '../server/placement-select';
import { capForPace, evaluatePlacementTermination } from '../server/placement-termination';

const NextBody = z.object({
  /** OPTIONAL client override of the probe's KC scope (YUK-470). The authoritative scope is
   * persisted server-side at /start (scope_knowledge_ids) and read under the row lock; this is
   * only an override for callers that legitimately need to widen/narrow (e.g. inc-E prereq
   * walk). Omit it and the server-side scope wins — the route no longer trusts the client to
   * re-send the scope every call. */
  knowledgeIds: z.array(z.string().min(1)).min(1).optional(),
  /** hard count cap override; defaults to PLACEMENT_DEFAULT_CAP (§6 Q1 = 8). Upper-bounded so
   * the anti-fatigue ceiling can't be trivially disabled by a buggy/oversized client value. */
  cap: z.number().int().min(1).max(50).optional(),
  /** optional θ SE early-stop threshold; null/omitted → cap-only termination. */
  seThreshold: z.number().positive().nullable().optional(),
});

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id } = params;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
    const parsed = NextBody.safeParse(raw);
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

      // The probe's ANSWER trail: review (solo) / attempt (paper) events on questions, chained
      // by session_id. answeredCount = answers so far; answeredIds = questions already answered.
      // The exclusion below is over the answer trail (not "served"): it relies on the answer-
      // before-next protocol (the client submits an answer via /api/review/submit, then calls
      // /next), so a question is never re-selected once answered. (event.subject_id is NOT NULL,
      // schema.ts.) Read inside the tx so it reflects answers committed before the lock was
      // acquired.
      const answeredRows = await tx
        .select({ subjectId: event.subject_id })
        .from(event)
        .where(
          and(
            eq(event.session_id, id),
            eq(event.subject_kind, 'question'),
            inArray(event.action, ['review', 'attempt']),
          ),
        );
      // DISTINCT answered questions: the cap counts QUESTIONS, not raw events. A question may
      // emit multiple review/attempt events (paper retry, client double-submit), which must NOT
      // inflate the count and prematurely terminate the probe. answeredIds drives both the cap
      // evaluation and the reported answeredCount.
      const answeredIds = Array.from(new Set(answeredRows.map((r) => r.subjectId)));
      const answeredCount = answeredIds.length;

      // Per-KC θ precision (cold KC with no mastery_state row → precision 1, the weak-prior cold
      // value the engine uses). Feeds the SE-convergence early stop. Fan out the independent
      // single-row reads concurrently (OCR major — avoid the N+1 serial await; same Promise.all
      // pattern as mastery-progress-signal.ts).
      const masteryStates = await Promise.all(knowledgeIds.map((kc) => getMasteryState(tx, kc)));
      const perKcPrecision = masteryStates.map((ms) => ms?.theta_precision ?? 1);

      const termination = evaluatePlacementTermination({
        answeredCount,
        // YUK-480 — an explicit client `cap` still wins (override), else the cap derives from the
        // self-reported pace persisted at /start (capForPace; NULL pace → PLACEMENT_DEFAULT_CAP,
        // byte-identical to the pre-YUK-480 default). Server-authoritative, mirroring scope.
        cap: cap ?? capForPace(session.pace),
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
      const next = await selectNextPlacementItem(tx, {
        knowledgeIds,
        excludeQuestionIds: answeredIds,
        preferKnowledgeIds,
      });
      return {
        done: false as const,
        question: next,
        answeredCount,
        sourcingNeeded: next === null,
      };
    });

    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
