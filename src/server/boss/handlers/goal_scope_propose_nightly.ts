// Station 2B / YUK-186 — nightly goal-scope propose handler.
//
// Structurally a clone of knowledge_edge_propose_nightly.ts: a thin
// candidate-picker + dedup gate + ONE call into runGoalScopeAndWrite (the
// PROPOSE half, src/server/goals/scope.ts). The cron does NOT re-implement the
// propose logic — runGoalScopeAndWrite already owns load-snapshot + the single
// structured-output GoalScopeTask call + parse + id-subset filter +
// writeAiProposal + failure-swallowing.
//
// Per run: most-active subject (selectSubjectsForRun(active, 1)) → skip the
// BR-4 default/orphan bucket → resolve profile → 3 dedup gates (live goal,
// pending proposal, has-weak-node) → at most ONE goal_scope proposal. Anti-storm
// (D3) is gates 2+3 keyed on subject_id, all BEFORE the LLM call.
//
// F-1 failure asymmetry (D7): the LLM/producer half is swallow-safe (its
// internal try/catch → EMPTY_RESULT → proposed:0, logged ledger). The pre-LLM
// DB reads run OUTSIDE that swallow — a throw there is a legit retryable DB
// fault that propagates to the builder's rethrow so pg-boss retries. Do NOT
// wrap the pre-LLM reads in a catch-all (would mask DB faults behind proposed:0).

import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { listActiveGoals } from '@/server/goals/queries';
import { runGoalScopeAndWrite } from '@/server/goals/scope';
import { loadTreeSnapshot } from '@/server/knowledge/tree';
import {
  listActiveSubjectsSinceRefresh,
  selectSubjectsForRun,
} from '@/server/memory/active-subjects';
import { KNOWN_SUBJECT_IDS, type KnownSubjectId, resolveSubjectProfile } from '@/subjects/profile';
import { loadPendingGoalScopeSubjects } from './goal_scope_dedup';

type DepsOverride = {
  runTaskFn?: TaskTextRunFn;
};

export interface GoalScopeNightlyResult {
  /** active subjects examined (0 or 1) */
  considered: number;
  /** 0 or 1 */
  proposed: number;
  skipped_existing_goal: number;
  skipped_pending: number;
  skipped_no_weak: number;
  proposal_id: string | null;
}

/** Weak-node convention: mastery < 0.55 (knowledge-readers.ts:321,644). A node
 *  with no mastery row reads as the neutral 0.5, which counts as weak. Extracted
 *  as a pure predicate so the FIX-6 "no weak nodes → skip" path is unit-testable
 *  without a DB round-trip (an all-mastered fixture is near-unreachable on the
 *  synthetic seed since evidence_count<3 nodes return 0.5 < 0.55). */
export function hasWeakNodeInDomain(
  tree: Array<{ effective_domain: string | null; mastery: number | null }>,
  domain: string,
): boolean {
  return tree.some((n) => n.effective_domain === domain && (n.mastery ?? 0.5) < 0.55);
}

/**
 * Pick the single most-active subject and, if it has ≥1 weak node and is not
 * already covered by a live goal / pending proposal, emit ONE goal_scope
 * proposal. Cap = 1 proposal/run. Empty active set → no-op early return.
 */
export async function runGoalScopeProposeNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<GoalScopeNightlyResult> {
  const empty: GoalScopeNightlyResult = {
    considered: 0,
    proposed: 0,
    skipped_existing_goal: 0,
    skipped_pending: 0,
    skipped_no_weak: 0,
    proposal_id: null,
  };

  // PRE-LLM reads run OUTSIDE runGoalScopeAndWrite's swallow (D7 / FIX-5): a
  // throw here is a legit retryable DB error (the builder rethrows → pg-boss
  // retries), NOT a logged skip. Do NOT wrap these in a catch-all.
  const active = await listActiveSubjectsSinceRefresh(db, {});
  const top = selectSubjectsForRun(active, 1);
  if (top.length === 0) return empty;
  const subjectId = top[0].subjectId; // a subject PROFILE-id (BR-4 bridge), not a domain

  // FIX-4: candidate quality — the BR-4 bridge resolves orphan events to a
  // synthetic default bucket. Don't propose a goal scoped to a non-profile id.
  if (!KNOWN_SUBJECT_IDS.includes(subjectId as KnownSubjectId)) {
    return { ...empty, considered: 1 }; // skip default/orphan bucket
  }

  // FIX-3: profile-id → domain. resolveSubjectProfile takes a domain/alias; for
  // wenyan profile-id == domain, but the general path is a registry lookup —
  // don't assume id == domain for code that could see another subject.
  const profile = resolveSubjectProfile(subjectId);
  const domain = profile.id;

  // Gate 2: skip subject with a live goal (same additive read Dreaming uses).
  const activeGoals = await listActiveGoals(db);
  if (activeGoals.some((g) => g.subject_id === subjectId)) {
    return { ...empty, considered: 1, skipped_existing_goal: 1 };
  }

  // Gate 3: skip subject with a pending goal_scope proposal. The pending scan's
  // rate query keys ONLY on caused_by_event_id (NO subject_kind filter) — the
  // goal accept/dismiss rate event is subject_kind:'event', so a goal filter
  // would match zero rows and permanently lock out re-propose (FIX-1).
  const pendingSubjects = await loadPendingGoalScopeSubjects(db);
  if (pendingSubjects.has(subjectId)) {
    return { ...empty, considered: 1, skipped_pending: 1 };
  }

  // FIX-2: candidate-has-weak-node check via the already-exported loadTreeSnapshot
  // (NOT loadMasteryMap — private — and NOT loadSubjectKnowledgeIds — nonexistent).
  // Filter by effective_domain (a DOMAIN), not the profile-id. The producer loads
  // the same tree once more inside runGoalScopeAndWrite; for a 1/night cron that
  // double-read is fine — do NOT add a shared-snapshot abstraction.
  const tree = await loadTreeSnapshot(db);
  if (!hasWeakNodeInDomain(tree, domain)) {
    return { ...empty, considered: 1, skipped_no_weak: 1 };
  }

  // From here the LLM half is swallow-safe (D7 / FIX-5): runGoalScopeAndWrite's
  // internal try/catch absorbs LLM/key/runner throws → EMPTY_RESULT, proposed:0.
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  const result = await runGoalScopeAndWrite({
    db,
    // FIX-4: a deterministic displayName placeholder anchor the user edits in the
    // inbox before accepting — NOT a name-resolution system. displayName is a
    // schema-required non-empty string (profile-schema.ts:41).
    goalTitle: profile.displayName || subjectId,
    subjectId,
    runTaskFn,
    subjectProfile: profile,
  });

  return {
    ...empty,
    considered: 1,
    proposed: result.proposal_id ? 1 : 0,
    proposal_id: result.proposal_id,
  };
}

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<Awaited<ReturnType<TaskTextRunFn>>> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return result;
}

export function buildGoalScopeProposeNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runGoalScopeProposeNightly(db);
      console.log('[goal_scope_propose_nightly] result', result);
    } catch (err) {
      console.error('[goal_scope_propose_nightly] failed', err);
      throw err;
    }
  };
}
