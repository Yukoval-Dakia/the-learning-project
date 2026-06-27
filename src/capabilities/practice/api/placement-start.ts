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

import { resolveSubjectKnowledgeIds } from '@/capabilities/knowledge/server/domain';
import { db } from '@/db/client';
import { goal } from '@/db/schema';
import { ApiError, errorResponse } from '@/server/http/errors';
import { Placement } from '@/server/session';
import { PLACEMENT_PROBE_ENABLED } from '@/server/session/placement';
import { eq } from 'drizzle-orm';
import { resolveLeaningPreferenceKcs, selectNextPlacementItem } from '../server/placement-select';

const StartBody = z.object({
  /** the goal whose scope_knowledge_ids scope this probe (KC set resolved from the goal row). */
  goalId: z.string().min(1).nullable().optional(),
  /** explicit goal-subgraph KC set (effective-domain derived); overrides goalId resolution. */
  knowledgeIds: z.array(z.string().min(1)).optional(),
  // YUK-480 — onboarding self-report transport (Welcome screen → placement). Both are ORDERING/
  // amount-only and NEVER feed θ̂/p(L)/FSRS (§3 red line 4); owner-supplied fixed inputs, n=1
  // admissible (§0.2 cat 1/2). Optional → a probe started without a self-report behaves exactly
  // as before (no preference / default cap).
  /** self-reported subject leanings (effective-domain subject ids) → PREFER leaning-subject
   * questions in selection order (placement-select preferKnowledgeIds). */
  leanings: z.array(z.string().min(1)).optional(),
  /** self-reported daily pace → probe count cap (capForPace), read by /next. */
  pace: z.enum(['light', 'medium', 'dense']).optional(),
});

export async function POST(req: Request): Promise<Response> {
  try {
    // Dark-ship gate: the whole placement entrypoint is unreachable until the flag flips.
    if (!PLACEMENT_PROBE_ENABLED) {
      throw new ApiError('not_found', 'placement probe is not enabled', 404);
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
    const parsed = StartBody.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { goalId, knowledgeIds: explicit, leanings, pace } = parsed.data;

    // Resolve the probe's KC scope: explicit set wins; else the goal's scope_knowledge_ids.
    // subject=view: the caller derives the KC set via the effective-domain axis (or supplies a
    // goal whose scope was so derived) — no subject root node is involved here.
    let knowledgeIds = explicit ?? [];
    if (knowledgeIds.length === 0 && goalId) {
      const rows = await db
        .select({ scope: goal.scope_knowledge_ids, subjectId: goal.subject_id })
        .from(goal)
        .where(eq(goal.id, goalId))
        .limit(1);
      const goalRow = rows[0];
      const frozenScope = goalRow?.scope ?? [];
      // YUK-482 Lane B (decision b-i, live-resolve guarded) — a cold-start goal is declared
      // on an empty tree (goal-create.ts: empty resolved scope is ALLOWED), so its FROZEN
      // scope_knowledge_ids stays empty even after uploads bridge new child KCs under the
      // subject root. A frozen-only read would make placement permanently blind to those KCs
      // (sourcingNeeded forever). When the frozen scope is empty/null AND the goal carries a
      // subject, RE-RESOLVE the subject's KC set LIVE (resolveSubjectKnowledgeIds → effective-
      // domain axis), so newly-bridged KCs enter scope. A NON-empty frozen scope is an
      // EXPLICIT narrow scope and is respected as-is (no live-resolve override). See
      // docs/design/2026-06-20-cold-start-day-one-design.md / YUK-481.
      knowledgeIds =
        frozenScope.length === 0 && goalRow?.subjectId
          ? await resolveSubjectKnowledgeIds(db, goalRow.subjectId)
          : frozenScope;
    }
    if (knowledgeIds.length === 0) {
      throw new ApiError(
        'validation_error',
        'placement requires a goalId (with scope_knowledge_ids) or an explicit knowledgeIds set',
        400,
      );
    }

    // YUK-480 — resolve the self-reported leanings into the preferred KC set (subject=view,
    // effective-domain axis). Empty/omitted leanings → empty set → first pick is byte-identical
    // to the pre-YUK-480 selection. This only orders WHICH question is served first; it never
    // touches the information score / θ̂.
    const preferKnowledgeIds = await resolveLeaningPreferenceKcs(db, leanings);

    // Select the first question BEFORE creating the session: the two ops are independent, and
    // ordering selection first means a selection failure leaves NO orphan 'started' row (nothing
    // is created yet). The only remaining orphan source — a probe started but never answered /
    // ended — is covered by the orphan-sweep follow-up (YUK-470).
    const first = await selectNextPlacementItem(db, { knowledgeIds, preferKnowledgeIds });
    // Persist the resolved scope on the session (YUK-470): /next reads it server-side rather
    // than trusting the client to re-send knowledgeIds every call. YUK-480 — persist the raw
    // self-report (leanings + pace) too so /next applies the leaning ordering + pace-derived cap
    // under the same row lock (raw, not the resolved KC set: re-resolving fresh on /next picks
    // up newly-bridged KCs, same rationale as the empty-frozen-scope live re-resolve above).
    const { sessionId } = await Placement.startPlacementSession(db, {
      goalId: goalId ?? null,
      knowledgeIds,
      leanings,
      pace: pace ?? null,
    });

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
