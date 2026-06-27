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

import {
  resolveAllActiveKnowledgeIds,
  resolveSubjectKnowledgeIds,
} from '@/capabilities/knowledge/server/domain';
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
    const { goalId, knowledgeIds: explicit } = parsed.data;

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
      // Three-tier dynamic scope resolution (YUK-481, building on YUK-482 Lane B). A cold-start
      // goal is declared on an empty tree (goal-create.ts: empty resolved scope is ALLOWED), so
      // its FROZEN scope_knowledge_ids stays empty even after uploads bridge new child KCs. A
      // frozen-only read would make placement permanently blind to those KCs (sourcingNeeded /
      // 400 forever). subject=view: scope is a DERIVED axis recomputed each call — we never write
      // the resolved set back onto the goal row. See docs/design/2026-06-20-cold-start-day-one-
      // design.md / YUK-481.
      if (frozenScope.length > 0) {
        // Tier 1: a NON-empty frozen scope is an EXPLICIT narrow scope — respected as-is, never
        // widened by live-resolve.
        knowledgeIds = frozenScope;
      } else {
        // Tier 2 (YUK-482 Lane B): frozen empty AND goal carries a subject → RE-RESOLVE the
        // subject's KC set LIVE (effective-domain axis, alias-aware), so newly-bridged KCs enter
        // scope.
        if (goalRow?.subjectId) {
          knowledgeIds = await resolveSubjectKnowledgeIds(db, goalRow.subjectId);
        }
        // Tier 3 (YUK-481): subject resolution still yielded nothing — no subject_id, an unknown
        // subject string, or a subject whose root is planted but has no child KC yet. This is the
        // original YUK-473 live trigger (day-one goals are often cross-subject / pick no subject).
        // Fall back to the FULL active tree rather than 400, so the cold-start probe is still
        // reachable. selectNextPlacementItem filters to KCs with ≥1 eligible question, so the
        // wide scope introduces no phantom KC. Cold-start crutch only: tier-2 takes over once a
        // subject is selected or uploads grow subject-scoped KCs.
        if (knowledgeIds.length === 0) {
          knowledgeIds = await resolveAllActiveKnowledgeIds(db);
        }
      }
    }
    if (knowledgeIds.length === 0) {
      // Post-YUK-481 this fires only in two genuinely-unresolvable cases: (a) neither a goalId nor
      // an explicit knowledgeIds set was supplied (nothing to resolve from), or (b) a goalId WAS
      // supplied but the entire active tree is empty (tier-3 full-tree fallback found zero active
      // KC) — there is truly nothing to place against. A no-subject / unknown-subject goal no
      // longer 400s as long as ANY active KC exists.
      throw new ApiError(
        'validation_error',
        'placement requires a goalId (with a resolvable scope) or an explicit knowledgeIds set',
        400,
      );
    }

    // Select the first question BEFORE creating the session: the two ops are independent, and
    // ordering selection first means a selection failure leaves NO orphan 'started' row (nothing
    // is created yet). The only remaining orphan source — a probe started but never answered /
    // ended — is covered by the orphan-sweep follow-up (YUK-470).
    const first = await selectNextPlacementItem(db, { knowledgeIds });
    // Persist the resolved scope on the session (YUK-470): /next reads it server-side rather
    // than trusting the client to re-send knowledgeIds every call.
    const { sessionId } = await Placement.startPlacementSession(db, {
      goalId: goalId ?? null,
      knowledgeIds,
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
