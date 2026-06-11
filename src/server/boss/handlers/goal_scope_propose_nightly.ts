// Station 2B / YUK-186 — nightly goal-scope propose handler.
//
// Structurally a clone of knowledge_edge_propose_nightly.ts: a thin
// candidate-picker + dedup gate + ONE call into runGoalScopeAndWrite (the
// PROPOSE half, src/server/goals/scope.ts). The cron does NOT re-implement the
// propose logic — runGoalScopeAndWrite already owns load-snapshot + the single
// structured-output GoalScopeTask call + parse + id-subset filter +
// writeAiProposal + failure-swallowing.
//
// Per run: pick the KNOWN domain with the MOST weak nodes (watermark-independent,
// over the same tree snapshot the producer reads) → resolve profile → 2 dedup
// gates (live goal, pending proposal) → at most ONE goal_scope proposal. The
// weak-node gate is folded into selection: skipped_no_weak fires when no known
// domain has any weak node. Anti-storm (D3) is gates 2+3 keyed on subject_id,
// all BEFORE the LLM call.
//
// FIX (Codex P1): the prior candidate selector gated on the active-subjects
// brief `refreshed_at` watermark (listActiveSubjectsSinceRefresh +
// selectSubjectsForRun). The memory_brief_sweep cron (03:00) advances that
// watermark for every active subject BEFORE this cron (03:50), so by 03:50 the
// active set was usually empty → the cron almost never proposed. We now select
// from accumulated MASTERY in the tree snapshot (watermark-independent), which
// matches the spec's "propose a goal from accumulated mastery" intent. Selecting
// only over KNOWN_SUBJECT_IDS also subsumes the prior BR-4 orphan-bucket guard:
// candidates are real knowledge-tree domains restricted to known profile ids.
//
// F-1 failure asymmetry (D7): the LLM/producer half is swallow-safe (its
// internal try/catch → EMPTY_RESULT → proposed:0, logged ledger). The pre-LLM
// DB reads run OUTSIDE that swallow — a throw there is a legit retryable DB
// fault that propagates to the builder's rethrow so pg-boss retries. Do NOT
// wrap the pre-LLM reads in a catch-all (would mask DB faults behind proposed:0).
// The pre-LLM reads are now loadTreeSnapshot + listActiveGoals + the pending scan.

import type { Job } from 'pg-boss';

import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
import type { Db } from '@/db/client';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { listActiveGoals } from '@/server/goals/queries';
import { runGoalScopeAndWrite } from '@/server/goals/scope';
import { KNOWN_SUBJECT_IDS, resolveSubjectProfile } from '@/subjects/profile';
import { loadPendingGoalScopeSubjects } from './goal_scope_dedup';

type DepsOverride = {
  runTaskFn?: TaskTextRunFn;
};

export interface GoalScopeNightlyResult {
  /** 1 if a candidate domain (a known domain with ≥1 weak node) was picked, else 0 */
  considered: number;
  /** 0 or 1 */
  proposed: number;
  skipped_existing_goal: number;
  skipped_pending: number;
  /** set when NO known domain has any weak node (no candidate to propose) */
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

/** Count of weak nodes in a domain (same 0.55 convention as hasWeakNodeInDomain).
 *  Drives the mastery-based candidate selection: the KNOWN domain with the most
 *  weak nodes wins (deterministic KNOWN_SUBJECT_IDS-order tie-break in the loop). */
export function countWeakNodesInDomain(
  tree: Array<{ effective_domain: string | null; mastery: number | null }>,
  domain: string,
): number {
  return tree.filter((n) => n.effective_domain === domain && (n.mastery ?? 0.5) < 0.55).length;
}

/**
 * Pick the KNOWN domain with the most accumulated weak nodes and, if it is not
 * already covered by a live goal / pending proposal, emit ONE goal_scope
 * proposal. Cap = 1 proposal/run. No known domain has any weak node → no-op
 * (skipped_no_weak).
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

  // PRE-LLM reads run OUTSIDE runGoalScopeAndWrite's swallow (D7 / F-1): a throw
  // here is a legit retryable DB error (the builder rethrows → pg-boss retries),
  // NOT a logged skip. Do NOT wrap these in a catch-all.
  const tree = await loadTreeSnapshot(db);

  // Mastery-based candidate selection (watermark-independent). Pick the KNOWN
  // domain with the most weak nodes; KNOWN_SUBJECT_IDS declaration order is the
  // deterministic tie-break (first-wins, strict `>` keeps earlier ids on ties).
  let domain: string | null = null;
  let bestWeak = 0;
  for (const candidate of KNOWN_SUBJECT_IDS) {
    const weak = countWeakNodesInDomain(tree, candidate);
    if (weak > bestWeak) {
      bestWeak = weak;
      domain = candidate;
    }
  }
  // No known domain has any weak node → nothing to propose. The weak-node gate
  // is folded into selection here (subsumes the old standalone has-weak gate).
  if (domain === null) return { ...empty, skipped_no_weak: 1 };

  // The picked domain IS a known profile id; subjectId for the goal == domain
  // (consistent with how the goal row's subject_id is stored + how Dreaming /
  // Coach read it). resolveSubjectProfile yields the title.
  const subjectId = domain;
  const profile = resolveSubjectProfile(domain);

  // Gate 2: skip subject with a live goal (same additive read Dreaming uses).
  const activeGoals = await listActiveGoals(db);
  if (activeGoals.some((g) => g.subject_id === subjectId)) {
    return { ...empty, considered: 1, skipped_existing_goal: 1 };
  }

  // Gate 3: skip subject with a pending goal_scope proposal. The pending scan's
  // rate/correct query keys ONLY on caused_by_event_id (NO subject_kind filter)
  // — the goal accept/dismiss rate event and the retract `correct` event are
  // both subject_kind:'event', so a goal filter would match zero rows and
  // permanently lock out re-propose (FIX-1 / FIX-3).
  const pendingSubjects = await loadPendingGoalScopeSubjects(db);
  if (pendingSubjects.has(subjectId)) {
    return { ...empty, considered: 1, skipped_pending: 1 };
  }

  // From here the LLM half is swallow-safe (D7 / F-1): runGoalScopeAndWrite's
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
