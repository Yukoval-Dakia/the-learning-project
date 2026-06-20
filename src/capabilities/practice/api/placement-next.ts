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

import { z } from 'zod';

import { db } from '@/db/client';
import { event } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { getMasteryState } from '@/server/mastery/state';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { selectNextPlacementItem } from '../server/placement-select';
import {
  PLACEMENT_DEFAULT_CAP,
  evaluatePlacementTermination,
} from '../server/placement-termination';

const NextBody = z.object({
  /** the goal-subgraph KC set this probe walks (same set passed to /start). */
  knowledgeIds: z.array(z.string().min(1)).min(1),
  /** hard count cap override; defaults to PLACEMENT_DEFAULT_CAP (§6 Q1 = 8). */
  cap: z.number().int().min(1).optional(),
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
    const { knowledgeIds, cap, seThreshold } = parsed.data;

    // Verify the probe exists and is still running (a completed/abandoned probe serves no more).
    const sessionRows = await db.execute(
      sql`SELECT status FROM learning_session WHERE id = ${id} AND type = 'placement' LIMIT 1`,
    );
    const sessionRow = (sessionRows as unknown as Array<{ status: string }>)[0];
    if (!sessionRow) {
      throw new ApiError('not_found', `placement session ${id} not found`, 404);
    }
    if (sessionRow.status !== 'started') {
      throw new ApiError(
        'conflict',
        `placement session ${id} is ${sessionRow.status}, not started`,
        409,
      );
    }

    // The probe's ANSWER trail: review (solo) / attempt (paper) events on questions, chained by
    // session_id. answeredCount = answers so far; answeredIds = questions already answered. The
    // exclusion below is over the answer trail (not "served"): it relies on the answer-before-
    // next protocol (the client submits an answer via /api/review/submit, then calls /next), so
    // a question is never re-selected once answered. (event.subject_id is NOT NULL, schema.ts.)
    const answeredRows = await db
      .select({ subjectId: event.subject_id })
      .from(event)
      .where(
        and(
          eq(event.session_id, id),
          eq(event.subject_kind, 'question'),
          inArray(event.action, ['review', 'attempt']),
        ),
      );
    const answeredCount = answeredRows.length;
    const answeredIds = Array.from(new Set(answeredRows.map((r) => r.subjectId)));

    // Per-KC θ precision (cold KC with no mastery_state row → precision 1, the weak-prior cold
    // value the engine uses). Feeds the SE-convergence early stop. Fan out the independent
    // single-row reads concurrently (OCR major — avoid the N+1 serial await; same Promise.all
    // pattern as mastery-progress-signal.ts).
    const masteryStates = await Promise.all(knowledgeIds.map((kc) => getMasteryState(db, kc)));
    const perKcPrecision = masteryStates.map((ms) => ms?.theta_precision ?? 1);

    const termination = evaluatePlacementTermination({
      answeredCount,
      cap: cap ?? PLACEMENT_DEFAULT_CAP,
      perKcPrecision,
      seThreshold: seThreshold ?? null,
    });
    if (termination.shouldStop) {
      // Probe is done — the client closes it via /api/placement/[id]/end (complete).
      return Response.json({ done: true, reason: termination.reason, answeredCount });
    }

    const next = await selectNextPlacementItem(db, {
      knowledgeIds,
      excludeQuestionIds: answeredIds,
    });
    return Response.json({
      done: false,
      question: next,
      answeredCount,
      sourcingNeeded: next === null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
