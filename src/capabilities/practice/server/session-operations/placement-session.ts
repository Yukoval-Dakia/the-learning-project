// placement-probe lifecycle port for the HTTP adapters in
// capabilities/practice/api/. Owns the sequencing the route files used to
// carry: the dark-ship gate, goal existence + scope resolution, leaning
// preference, two-phase first-item selection, Transaction A (starter
// materialization + session start), the paid-claim dispatch loop's failure
// contract, the locked question-serving transaction, and the repeatable-read
// side reads (starter outcomes, unresolved items). api/* keeps Request
// parsing, schema validation, and Response/deprecation shaping.
// Moved verbatim from api/placement-{start,end,session-detail}.ts — every
// transaction boundary, catch contract, lock, and read isolation is unchanged.

import { and, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { goal, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import {
  noItemField,
  placementNoItem,
  recordPlacementNoItem,
  unresolvedField,
} from '../placement-advance';
import {
  ensurePlacementAssessment,
  placementAssessmentProgress,
  readPlacementSessionInfo,
  readPlacementUnresolvedItems,
} from '../placement-assessment';
import { resolveGoalPlacementScope, resolveNearbyPlacementScope } from '../placement-scope';
import { resolveLeaningPreferenceKcs, selectNextPlacementItem } from '../placement-select';
import * as Placement from '../placement-session-lifecycle';
import { dispatchPlacementStarterClaim } from '../question-supply/placement-starter';
import { readPlacementStarterOutcomes } from '../question-supply/placement-starter-outcome-reader';
import { materializePlacementStartersForGoal } from '../question-supply/placement-starter-store';
import { lockPlacementSupplyScopes } from '../question-supply/placement-supply-lock';

// ---------- start probe (POST /api/placement/start + /api/placement-sessions) ----------

export interface StartPlacementProbeInput {
  goalId?: string | null;
  knowledgeIds?: readonly string[];
  leanings?: readonly string[];
  pace?: string | null;
}

export interface PlacementProbeStart {
  sessionId: string;
  knowledgeIds: string[];
  question: Awaited<ReturnType<typeof ensurePlacementAssessment>>;
  starterSupply: Awaited<ReturnType<typeof readPlacementStarterOutcomes>>;
  answeredCount: 0;
  sourcingNeeded: boolean;
  no_item?: ReturnType<typeof placementNoItem>;
}

export async function startPlacementProbe(
  loadInput: () => Promise<StartPlacementProbeInput>,
): Promise<PlacementProbeStart> {
  // Dark-ship gate: the whole placement entrypoint is unreachable until the flag flips.
  if (!Placement.placementProbeEnabled()) {
    throw new ApiError('not_found', 'placement probe is not enabled', 404);
  }

  // The entry gate precedes HTTP parsing, as in the original route.
  const { goalId, knowledgeIds: explicit, leanings, pace } = await loadInput();

  let knowledgeIds: string[] = [...(explicit ?? [])];
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
    // Post- this fires only in two genuinely-unresolvable cases: (a) neither a goalId nor
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

  // resolve the self-reported leanings into the preferred KC set (subject=view,
  // effective-domain axis). Empty/omitted leanings → empty set → first pick is byte-identical
  // to the pre- selection. This only orders WHICH question is served first; it never
  // touches the information score / θ̂.
  const preferKnowledgeIds = await resolveLeaningPreferenceKcs(db, leanings);

  // Select the first question BEFORE creating the session: the two ops are independent, and
  // ordering selection first means a selection failure leaves NO orphan 'started' row (nothing
  // is created yet). The only remaining orphan source — a probe started but never answered /
  // ended — is covered by the orphan-sweep follow-up.
  // L2 — before declaring the target cold, also try the SAME-SUBJECT widened
  // scope: an already-admitted, automatically servable item nearby counts as a real
  // first item and spares the learner the supply wait entirely.
  let fallbackKnowledgeIds = await resolveNearbyPlacementScope(
    db,
    knowledgeIds,
    requestedGoal?.subjectId ?? null,
  );
  let first =
    (await selectNextPlacementItem(db, { knowledgeIds, preferKnowledgeIds })) ??
    (fallbackKnowledgeIds.length > knowledgeIds.length
      ? await selectNextPlacementItem(db, {
          knowledgeIds: fallbackKnowledgeIds,
          preferKnowledgeIds,
        })
      : null);
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
        .where(eq(goal.id, goalId))
        .limit(1);
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
    fallbackKnowledgeIds = await resolveNearbyPlacementScope(
      db,
      knowledgeIds,
      requestedGoal?.subjectId ?? null,
    );
    first =
      (await selectNextPlacementItem(db, { knowledgeIds, preferKnowledgeIds })) ??
      (fallbackKnowledgeIds.length > knowledgeIds.length
        ? await selectNextPlacementItem(db, {
            knowledgeIds: fallbackKnowledgeIds,
            preferKnowledgeIds,
          })
        : null);
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
          await lockPlacementSupplyScopes(tx, knowledgeIds);
          const eligible = await selectNextPlacementItem(tx, {
            knowledgeIds,
            preferKnowledgeIds,
          });
          return eligible === null;
        });
      } catch (err) {
        // The claim was materialized (committed) in Transaction A above but its quiz_gen dispatch
        // failed. It stays 'pending_dispatch'. Two recovery paths now exist: (a) a SUBSEQUENT
        // placement/start for the same goal — materialize is idempotent on the deterministic
        // claim id and dispatchPlacementStarterClaimTx re-dispatches a still-'pending_dispatch'
        // claim; and (b) 's background sweeper, which consumes
        // placement_starter_claim_recovery_idx / next_reconcile_at from the tail of
        // question_supply_nightly and re-drives the claim even if the learner never returns
        // (src/capabilities/practice/server/placement-starter-recovery.ts). A stranded pending
        // claim is HARMLESS in the meantime: it is exempt from
        // the placement_starter_claim_nonterminal_uq single-flight guard (round-2), so it blocks no
        // later revision. If re-dispatch collides with another revision's live paid flight, its
        // savepoint enqueue is rolled back and the claim stays pending until that flight ends —
        // never an irreversible cancellation or a 500. We surface sourcingNeeded to the client
        // rather than failing the whole probe.
        console.error(
          `[placement-starter] initial dispatch failed for ${claimId}; claim left pending_dispatch, a subsequent placement start re-dispatches it`,
          err,
        );
      }
    }
  }

  const question = await db.transaction(async (tx) => {
    await Placement.loadPlacementSessionForUpdate(tx, sessionId);
    const info = await readPlacementSessionInfo(tx, sessionId);
    const progress = await placementAssessmentProgress(tx, sessionId);
    const next = await ensurePlacementAssessment(
      tx,
      sessionId,
      { knowledgeIds, fallbackKnowledgeIds, preferKnowledgeIds },
      progress,
      { startedAt: info?.startedAt ?? null },
    );
    if (next === null) {
      // L2 — record the real elapsed time to the first alternative
      // (once per session; the marker is first-write-wins).
      await recordPlacementNoItem(tx, sessionId, info?.startedAt ?? null, 0);
    }
    return next;
  });
  const starterSupply = await db.transaction((tx) => readPlacementStarterOutcomes(tx, sessionId), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
  // Keep sourcingNeeded for compatibility; fresh sessions omit unresolved_items.
  return {
    sessionId,
    knowledgeIds,
    question,
    answeredCount: 0,
    sourcingNeeded: question === null,
    starterSupply,
    ...noItemField(question === null ? placementNoItem(starterSupply) : null),
  };
}

// ---------- end probe (POST /api/placement/[id]/end) ----------

export async function endPlacementSession(
  sessionId: string,
  status: 'completed' | 'abandoned',
): Promise<Awaited<ReturnType<typeof readPlacementUnresolvedItems>>> {
  if (status === 'completed') {
    await Placement.completePlacementSession(db, sessionId);
  } else {
    await Placement.abandonPlacementSession(db, sessionId);
  }
  // L1 — the honest end: items closed without a verdict are marked,
  // not silently dropped (held/pending → awaiting_evaluation; released →
  // held_released; an issued-but-never-answered card → unanswered).
  return db.transaction((tx) => readPlacementUnresolvedItems(tx, sessionId), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}

// ---------- detail read (GET /api/placement-sessions/[id]) ----------

export async function readPlacementSession(sessionId: string) {
  return db.transaction(
    async (tx) => {
      const rows = await tx
        .select({
          id: learning_session.id,
          type: learning_session.type,
          status: learning_session.status,
          goal_id: learning_session.goal_id,
          scope_knowledge_ids: learning_session.scope_knowledge_ids,
          started_at: learning_session.started_at,
          ended_at: learning_session.ended_at,
          updated_at: learning_session.updated_at,
        })
        .from(learning_session)
        .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'placement')))
        .limit(1);
      const session = rows[0];
      if (!session) {
        throw new ApiError('not_found', `placement session ${sessionId} not found`, 404);
      }
      return {
        ...session,
        starterSupply: await readPlacementStarterOutcomes(tx, sessionId),
        // Preserve the HTTP projection, including omission when nothing is unresolved.
        ...unresolvedField(await readPlacementUnresolvedItems(tx, sessionId)),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

// ---------- idempotent transition (PATCH /api/placement-sessions/[id]) ----------

export async function transitionPlacementSession(
  sessionId: string,
  target: 'completed' | 'abandoned',
) {
  const transition = await Placement.transitionPlacementSession(db, sessionId, target);
  // L1 — the honest end result marks every item that closed without a
  // verdict (held-release 'end' half lands here: no new route needed).
  const unresolvedItems = await db.transaction(
    (tx) => readPlacementUnresolvedItems(tx, sessionId),
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  return {
    id: sessionId,
    type: 'placement' as const,
    previous_status: transition.previousStatus,
    status: transition.status,
    changed: transition.changed,
    allowed_statuses: transition.allowedStatuses,
    ...unresolvedField(unresolvedItems),
  };
}
