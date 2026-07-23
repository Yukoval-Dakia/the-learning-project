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

import { db } from '@/db/client';
import { goal } from '@/db/schema';
import { canonicalResourceResponse, deprecatedRouteResponse } from '@/kernel/http';
import { ApiError, errorResponse } from '@/server/http/errors';
import { dispatchPlacementStarterClaim } from '@/server/question-supply/placement-starter';
import { materializePlacementStartersForGoal } from '@/server/question-supply/placement-starter-store';
import { Placement } from '@/server/session';
import { PLACEMENT_PROBE_ENABLED } from '@/server/session/placement';
import { eq } from 'drizzle-orm';
import { resolveGoalPlacementScope } from '../server/placement-scope';
import { resolveLeaningPreferenceKcs, selectNextPlacementItem } from '../server/placement-select';
import { CreatePlacementSessionBodySchema } from './placement-contracts';

export async function createPlacementSession(req: Request): Promise<Response> {
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
    const parsed = CreatePlacementSessionBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { goalId, knowledgeIds: explicit, leanings, pace } = parsed.data;

    let knowledgeIds = explicit ?? [];
    let requestedGoal:
      | {
          scope: string[] | null;
          subjectId: string | null;
          scopeMode: 'explicit' | 'subject_live';
        }
      | undefined;
    // Validate a requested goal before permissive tier-3 resolution or warm selection. This is an
    // existence check only: paid-subject authority is resolved later, only on the cold path.
    if (goalId) {
      const [goalRow] = await db
        .select({
          scope: goal.scope_knowledge_ids,
          subjectId: goal.subject_id,
          scopeMode: goal.scope_mode,
        })
        .from(goal)
        .where(eq(goal.id, goalId))
        .limit(1);
      if (!goalRow) throw new ApiError('not_found', `goal not found: ${goalId}`, 404);
      requestedGoal = goalRow;
    }
    if (knowledgeIds.length === 0 && requestedGoal) {
      knowledgeIds = await resolveGoalPlacementScope(db, requestedGoal);
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

    // YUK-480 — resolve the self-reported leanings into the preferred KC set (subject=view,
    // effective-domain axis). Empty/omitted leanings → empty set → first pick is byte-identical
    // to the pre-YUK-480 selection. This only orders WHICH question is served first; it never
    // touches the information score / θ̂.
    const preferKnowledgeIds = await resolveLeaningPreferenceKcs(db, leanings);

    // Select the first question BEFORE creating the session: the two ops are independent, and
    // ordering selection first means a selection failure leaves NO orphan 'started' row (nothing
    // is created yet). The only remaining orphan source — a probe started but never answered /
    // ended — is covered by the orphan-sweep follow-up (YUK-470).
    let first = await selectNextPlacementItem(db, { knowledgeIds, preferKnowledgeIds });
    const claimIds: string[] = [];
    let sessionId: string;
    if (first === null && goalId) {
      ({ sessionId, knowledgeIds } = await db.transaction(async (tx) => {
        const { identities } = await materializePlacementStartersForGoal(tx, goalId);
        claimIds.push(...identities.map((identity) => identity.claimId));
        const [goalRow] = await tx
          .select({
            scope: goal.scope_knowledge_ids,
            subjectId: goal.subject_id,
            scopeMode: goal.scope_mode,
          })
          .from(goal)
          .where(eq(goal.id, goalId));
        const effectiveScope = await resolveGoalPlacementScope(tx, {
          scope: goalRow?.scope ?? null,
          subjectId: goalRow?.subjectId ?? null,
          scopeMode: goalRow?.scopeMode ?? 'explicit',
        });
        const started = await Placement.startPlacementSession(tx, {
          goalId,
          knowledgeIds: effectiveScope,
          leanings,
          pace: pace ?? null,
        });
        return { sessionId: started.sessionId, knowledgeIds: effectiveScope };
      }));
      // Re-select after Transaction A and immediately before paid admission. A verifier promotion
      // racing the first read must suppress dispatch rather than create unnecessary paid work.
      first = await selectNextPlacementItem(db, { knowledgeIds, preferKnowledgeIds });
    } else {
      ({ sessionId } = await Placement.startPlacementSession(db, {
        goalId: goalId ?? null,
        knowledgeIds,
        leanings,
        pace: pace ?? null,
      }));
    }

    // Paid starter work is cold-only after the post-Transaction-A re-selection.
    if (first === null) {
      for (const claimId of claimIds) {
        try {
          await dispatchPlacementStarterClaim(db, claimId, async (tx) => {
            const eligible = await selectNextPlacementItem(tx, {
              knowledgeIds,
              preferKnowledgeIds,
            });
            return eligible === null;
          });
        } catch (err) {
          console.error(
            `[placement-starter] initial dispatch failed for ${claimId}; recovery owns retry`,
            err,
          );
        }
      }
    }

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
