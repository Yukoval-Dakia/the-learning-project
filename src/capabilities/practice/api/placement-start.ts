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

import { z } from 'zod';

import { db } from '@/db/client';
import { goal } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { Placement } from '@/server/session';
import { PLACEMENT_PROBE_ENABLED } from '@/server/session/placement';
import { eq } from 'drizzle-orm';
import { selectNextPlacementItem } from '../server/placement-select';

const StartBody = z.object({
  /** the goal whose scope_knowledge_ids scope this probe (KC set resolved from the goal row). */
  goalId: z.string().min(1).nullable().optional(),
  /** explicit goal-subgraph KC set (effective-domain derived); overrides goalId resolution. */
  knowledgeIds: z.array(z.string().min(1)).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    // Dark-ship gate: the whole placement entrypoint is unreachable until the flag flips.
    if (!PLACEMENT_PROBE_ENABLED) {
      throw new ApiError('not_found', 'placement probe is not enabled', 404);
    }

    const raw = await req.json().catch(() => ({}));
    const parsed = StartBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { goalId, knowledgeIds: explicit } = parsed.data;

    // Resolve the probe's KC scope: explicit set wins; else the goal's scope_knowledge_ids.
    // subject=view: the caller derives the KC set via the effective-domain axis (or supplies a
    // goal whose scope was so derived) — no subject root node is involved here.
    let knowledgeIds = explicit ?? [];
    if (knowledgeIds.length === 0 && goalId) {
      const rows = await db
        .select({ scope: goal.scope_knowledge_ids })
        .from(goal)
        .where(eq(goal.id, goalId))
        .limit(1);
      knowledgeIds = rows[0]?.scope ?? [];
    }
    if (knowledgeIds.length === 0) {
      throw new ApiError(
        'validation_error',
        'placement requires a goalId (with scope_knowledge_ids) or an explicit knowledgeIds set',
        400,
      );
    }

    const { sessionId } = await Placement.startPlacementSession(db, { goalId: goalId ?? null });
    const first = await selectNextPlacementItem(db, { knowledgeIds });

    // first === null → cold subgraph (no eligible question). The probe stays 'started'; the
    // client should source questions for the goal (§6 Q3 —按目标生成 placement 起始题, via
    // quiz_gen) and then poll /api/placement/[id]/next. We surface the need rather than
    // silently returning an empty probe.
    return Response.json({
      sessionId,
      knowledgeIds,
      question: first,
      sourcingNeeded: first === null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
