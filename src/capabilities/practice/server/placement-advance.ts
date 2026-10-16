// YUK-1405 — shared placement advance for POST question-selections and POST held-release.
//
// The whole read-select cycle runs in ONE transaction that row-locks the placement
// session (loadPlacementSessionForUpdate → SELECT … FOR UPDATE), serializing concurrent
// selections and releases on the same probe (YUK-470 part 1 idiom). This module is the
// single seam for the advance path's server-side deps (session lock, mastery state) so
// the API handlers stay dependency-free at the capability boundary.
//
// L1 (held exit): `releaseIssuanceId` records a durable release marker for the session's
// currently-held issuance, then the SAME advance runs — the held item stays unresolved
// (never counted as wrong) and the probe moves on. The marker is first-write-wins on a
// deterministic id, so refresh/re-entry re-derives the identical next action.
//
// L2 (cold target): when the probe's own scope yields no automatically servable item,
// selection retries over the nearby same-subject scope (resolveNearbyPlacementScope);
// when nothing is servable at all, a once-per-session marker event records the real
// elapsed session→first-alternative time. The starter-supply lease/deadline machinery
// in placement-starter-attempts.ts is untouched — the learner just never waits on it.

import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import { canonicalHash } from '@/core/migration/canonical';
import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { getMasteryState } from '@/server/mastery/state';
import { loadPlacementSessionForUpdate } from '@/server/session/placement';
import type { PlacementNoItemSchema, PlacementUnresolvedItem } from '../api/placement-contracts';
import {
  ensurePlacementAssessment,
  placementAssessmentProgress,
  readPlacementSessionInfo,
  writePlacementHeldRelease,
} from './placement-assessment';
import { resolveNearbyPlacementScope } from './placement-scope';
import { resolveLeaningPreferenceKcs } from './placement-select';
import {
  PLACEMENT_DEFAULT_CAP,
  capForPace,
  evaluatePlacementTermination,
} from './placement-termination';
import type { PlacementStarterOutcome } from './question-supply/placement-starter-outcome';

/** YUK-1405 L2 — once-per-session marker for the first "no servable item" outcome. */
export const PLACEMENT_NO_ITEM_ACTION = 'experimental:assessment_placement_no_item';

export interface PlacementAdvanceOptions {
  /** Client scope override (YUK-470 part 2): persisted scope wins when omitted. */
  scopeOverride?: readonly string[];
  cap?: number;
  seThreshold?: number | null;
  /** L1 — release this (currently-held) issuance before advancing. */
  releaseIssuanceId?: string;
}

export interface PlacementAdvanceOutcome {
  selection:
    | {
        done: true;
        reason: 'cap' | 'se_converged';
        answeredCount: number;
        unresolved_items: PlacementUnresolvedItem[];
      }
    | {
        done: false;
        question: Awaited<ReturnType<typeof placementAssessmentProgress>>['outstanding'];
        answeredCount: number;
        sourcingNeeded: boolean;
        unresolved_items: PlacementUnresolvedItem[];
      };
  /** Present when a held-release was requested; `replayed` marks a repeat call. */
  release: { released: true; replayed: boolean } | null;
}

export async function runPlacementAdvanceTx(
  db: Db,
  sessionId: string,
  options: PlacementAdvanceOptions = {},
): Promise<PlacementAdvanceOutcome> {
  return db.transaction(async (tx) => {
    // FOR UPDATE-lock the session + read its status AND server-side scope. A second
    // concurrent advance blocks here until the first tx commits, then re-reads.
    const session = await loadPlacementSessionForUpdate(tx, sessionId);
    if (!session) {
      throw new ApiError('not_found', `placement session ${sessionId} not found`, 404);
    }
    if (session.status !== 'started') {
      throw new ApiError(
        'conflict',
        `placement session ${sessionId} is ${session.status}, not started`,
        409,
      );
    }
    const info = await readPlacementSessionInfo(tx, sessionId);

    // Scope is server-side authoritative (YUK-470 part 2): persisted at /start
    // (scope_knowledge_ids). The client param is only an optional override; when omitted,
    // the persisted scope wins — the route no longer trusts the client body for scope.
    const knowledgeIds = options.scopeOverride ?? session.scopeKnowledgeIds ?? [];
    if (knowledgeIds.length === 0) {
      throw new ApiError(
        'validation_error',
        `placement session ${sessionId} has no scope (no persisted scope_knowledge_ids and no knowledgeIds override)`,
        400,
      );
    }

    let progress = await placementAssessmentProgress(tx, sessionId);
    let release: PlacementAdvanceOutcome['release'] = null;
    if (options.releaseIssuanceId) {
      const target = options.releaseIssuanceId;
      const alreadyReleased = progress.releasedIssuanceIds.has(target);
      if (!alreadyReleased) {
        const held = progress.outstanding;
        // The id must name the LIVE held item — releasing anything else would let a
        // caller skip past an earlier unsettled item (ordering invariant) or fabricate
        // a release for an item that never held.
        if (held?.assessment.phase !== 'held' || held.assessment.issuance_id !== target) {
          throw new ApiError(
            'not_releasable',
            `issuance ${target} is not this placement session's held item`,
            409,
          );
        }
        await writePlacementHeldRelease(tx, sessionId, held);
        // Re-derive under the same lock so the advance below sees the release.
        progress = await placementAssessmentProgress(tx, sessionId);
      }
      release = { released: true, replayed: alreadyReleased };
    }

    const { answeredIds, answeredCount, unresolved } = progress;
    if (progress.outstanding) {
      return {
        selection: {
          done: false as const,
          question: progress.outstanding,
          answeredCount,
          sourcingNeeded: false,
          unresolved_items: unresolved,
        },
        release,
      };
    }

    // Per-KC θ precision (cold KC with no mastery_state row → precision 1, the weak-prior
    // cold value the engine uses). Feeds the SE-convergence early stop.
    const masteryStates = await Promise.all(knowledgeIds.map((kc) => getMasteryState(tx, kc)));
    const perKcPrecision = masteryStates.map((ms) => ms?.theta_precision ?? 1);

    const termination = evaluatePlacementTermination({
      answeredCount,
      // YUK-480 — an explicit client `cap` overrides the pace-derived cap (capForPace; NULL
      // pace → PLACEMENT_DEFAULT_CAP), but PLACEMENT_DEFAULT_CAP is a hard server ceiling.
      cap: Math.min(options.cap ?? capForPace(session.pace), PLACEMENT_DEFAULT_CAP),
      perKcPrecision,
      seThreshold: options.seThreshold ?? null,
    });
    if (termination.shouldStop) {
      // shouldStop guarantees a binding reason (placement-termination contract).
      if (termination.reason === null) {
        throw new ApiError('corrupt_state', 'placement termination stopped without a reason', 409);
      }
      return {
        selection: {
          done: true as const,
          reason: termination.reason,
          answeredCount,
          unresolved_items: unresolved,
        },
        release,
      };
    }

    // Leaning preference + nearby scope are INDEPENDENT knowledge-table reads (subject
    // effective-domain axis), NOT part of this probe's session-lock serialization — the
    // locked session row (leanings, scope) is already in hand. Resolved on `db`, ordered-
    // only; neither feeds θ̂/p(L).
    const preferKnowledgeIds = await resolveLeaningPreferenceKcs(db, session.leanings);
    const subjectId = info?.goalId ? await readGoalSubjectId(tx, info.goalId) : null;
    const fallbackKnowledgeIds = await resolveNearbyPlacementScope(db, knowledgeIds, subjectId);
    const next = await ensurePlacementAssessment(
      tx,
      sessionId,
      {
        knowledgeIds,
        fallbackKnowledgeIds,
        excludeQuestionIds: answeredIds,
        preferKnowledgeIds,
      },
      progress,
      { startedAt: info?.startedAt ?? null },
    );
    if (next === null) {
      await recordPlacementNoItem(tx, sessionId, info?.startedAt ?? null, answeredCount);
    }
    return {
      selection: {
        done: false as const,
        question: next,
        answeredCount,
        sourcingNeeded: next === null,
        unresolved_items: unresolved,
      },
      release,
    };
  });
}

async function readGoalSubjectId(tx: Tx, goalId: string): Promise<string | null> {
  const [row] = await tx
    .select({ subjectId: goal.subject_id })
    .from(goal)
    .where(eq(goal.id, goalId))
    .limit(1);
  return row?.subjectId ?? null;
}

/**
 * YUK-1405 L2 — record the real elapsed session→first-alternative time, once per
 * session (deterministic event id + first-write-wins: later empty selections do not
 * rewrite the first observation). Written inside the same locked tx that produced
 * the empty selection, so it never fires without the outcome it describes.
 */
export async function recordPlacementNoItem(
  tx: Tx,
  sessionId: string,
  startedAt: Date | null,
  answeredCount: number,
): Promise<void> {
  await writeEvent(tx, {
    id: `evt_placement_noitem_${canonicalHash({ sessionId })}`,
    session_id: sessionId,
    actor_kind: 'user',
    actor_ref: 'self',
    action: PLACEMENT_NO_ITEM_ACTION,
    subject_kind: 'learning_session',
    subject_id: sessionId,
    outcome: null,
    payload: {
      elapsed_ms: startedAt ? Math.max(0, Date.now() - startedAt.getTime()) : 0,
      answered_count: answeredCount,
    },
  });
}

/** L2 — the typed alternative attached post-tx when a selection yields no item. */
export function placementNoItem(
  starterSupply: readonly PlacementStarterOutcome[],
): z.infer<typeof PlacementNoItemSchema> {
  return {
    reason: 'no_servable_item',
    preparing_subjects: starterSupply
      .filter((outcome) => outcome.state === 'pending')
      .map((outcome) => outcome.subject_id),
    options: ['recheck', 'end'],
  };
}
