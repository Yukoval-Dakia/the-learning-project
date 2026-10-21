// Nightly goal-scope propose handler.
//
// A thin candidate-picker + dedup gate + ONE call into runGoalScopeAndWrite (the PROPOSE
// half, ../server/goals/scope.ts), which owns the snapshot load, the structured-output
// GoalScopeTask call, parse, id-subset filter, writeAiProposal and failure swallowing.
//
// Per run: pick the KNOWN domain with the most weak nodes (watermark-independent, over the
// same tree snapshot the producer reads) → resolve profile → dedup gates (live goal,
// pending proposal, dismiss cooldown) → at most ONE goal_scope proposal.
//
// Failure asymmetry: the LLM/producer half swallows faults into EMPTY_RESULT. The pre-LLM
// DB reads run OUTSIDE that swallow — a throw there is a legit retryable DB fault that must
// propagate so pg-boss retries. Do NOT wrap the pre-LLM reads in a catch-all.

import type { Job } from 'pg-boss';

import { runGoalScopeAndWrite } from '@/capabilities/agency/server/goals/scope';
// 跨包深 import knowledge 内部模块——包边界收紧时应换走 knowledge 包对外导出面。
import { loadTreeSnapshot } from '@/capabilities/knowledge/public';
import type { Db } from '@/db/client';
import { listActiveGoals } from '@/kernel/read-models/active-goal-scope';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { getDefaultSubjectRegistry, resolveSubjectProfile } from '@/subjects/profile';
import { type TaskTextRunFn, makeRunTaskFn } from '../server/ai-runtime';
import { loadDismissedGoalScopeSubjects, loadPendingGoalScopeSubjects } from './goal_scope_dedup';

type DepsOverride = {
  runTaskFn?: TaskTextRunFn;
};

export interface GoalScopeNightlyResult {
  /** 1 if a candidate domain (a known domain with ≥1 weak node) was picked, else 0 */
  considered: number;
  proposed: number;
  skipped_existing_goal: number;
  skipped_pending: number;
  /** no known domain has any weak node */
  skipped_no_weak: number;
  proposal_id: string | null;
  /** 1 when runGoalScopeAndWrite SWALLOWED a fault (`ok === false`), else 0. */
  llm_failed: number;
  /**
   * 1 once runGoalScopeAndWrite was actually CALLED, else 0. Deliberately NOT
   * `considered`: gates 2/3 return `considered: 1` while short-circuiting before the
   * LLM half, and the yield invariant is attempted === succeeded + failed.
   */
  llm_attempted: number;
}

/** Weak = mastery < 0.55; a missing mastery row reads as the neutral 0.5 (weak). */
export function hasWeakNodeInDomain(
  tree: Array<{ effective_domain: string | null; mastery: number | null }>,
  domain: string,
): boolean {
  return tree.some((n) => n.effective_domain === domain && (n.mastery ?? 0.5) < 0.55);
}

/** Weak nodes in a domain (same 0.55 convention); drives candidate selection. */
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
    llm_failed: 0,
    // Early returns spread `empty`, so pre-LLM gates report the model was never called.
    llm_attempted: 0,
  };

  // These reads run OUTSIDE runGoalScopeAndWrite's swallow: a throw is a retryable DB
  // error (pg-boss retries), NOT a logged skip. Do NOT wrap them in a catch-all.
  const tree = await loadTreeSnapshot(db);

  // Pick the selectable domain with the most weak nodes; registry order is the
  // deterministic tie-break (strict `>`, first wins). A candidate needs ≥5 KCs —
  // thin or root-only subjects are not worth a nightly LLM proposal.
  let domain: string | null = null;
  let bestWeak = 0;
  for (const candidate of getDefaultSubjectRegistry().getSelectableSubjectIds()) {
    const kcs = await resolveSubjectKnowledgeIds(db, candidate);
    if (kcs.length < 5) continue; // fan-out gate：内容太薄不提案
    const weak = countWeakNodesInDomain(tree, candidate);
    if (weak > bestWeak) {
      bestWeak = weak;
      domain = candidate;
    }
  }
  // No known domain has any weak node → nothing to propose.
  if (domain === null) return { ...empty, skipped_no_weak: 1 };

  // subjectId == domain, matching how the goal row stores subject_id and how Dreaming /
  // Coach read it; the profile supplies the title.
  const subjectId = domain;
  const profile = resolveSubjectProfile(domain);

  // Gate 2: skip subject with a live goal (same additive read Dreaming uses).
  const activeGoals = await listActiveGoals(db);
  if (activeGoals.some((g) => g.subject_id === subjectId)) {
    return { ...empty, considered: 1, skipped_existing_goal: 1 };
  }

  // Gate 3: skip subject with a pending goal_scope proposal. Its decision query has no
  // subject_kind filter (see goal_scope_dedup) — adding one matches zero rows.
  const pendingSubjects = await loadPendingGoalScopeSubjects(db);
  if (pendingSubjects.has(subjectId)) {
    return { ...empty, considered: 1, skipped_pending: 1 };
  }

  // Gate 3.5: dismiss-churn 冷却——冷却窗内被 dismiss 的 subject 不重提；
  // skipped_pending 计数复用（同「今晚不提」语义桶，不新增 result 字段）。
  const dismissedSubjects = await loadDismissedGoalScopeSubjects(db);
  if (dismissedSubjects.has(subjectId)) {
    return { ...empty, considered: 1, skipped_pending: 1 };
  }

  // From here the LLM half is swallow-safe: runGoalScopeAndWrite's internal try/catch
  // absorbs LLM/key/runner throws → EMPTY_RESULT, proposed:0.
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
  const result = await runGoalScopeAndWrite({
    db,
    // A deterministic displayName placeholder the user edits in the inbox before
    // accepting — NOT a name-resolution system; displayName must be non-empty.
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
    // Surface the swallow instead of letting it collapse into proposed:0. Not hardcoded
    // 1: runGoalScopeAndWrite can return before reaching the model (empty tree →
    // `!prepared`), so the flag must come from it.
    llm_attempted: result.llm_attempted ? 1 : 0,
    llm_failed: result.ok ? 0 : 1,
  };
}

export function buildGoalScopeProposeNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<JobYieldOutput> {
  return async () => {
    try {
      const result = await runGoalScopeProposeNightly(db);
      console.log('[goal_scope_propose_nightly] result', result);
      // The fallible unit is the single LLM half, counted by `llm_attempted`. Must NOT be
      // `considered`: gates 2/3 return considered:1 while short-circuiting before the LLM
      // runs, which would report success on a gated night and break
      // attempted === succeeded + failed. OR-ing llm_failed keeps a fault swallowed before
      // the model is reached from reading as `idle`.
      const attempted = result.llm_attempted || result.llm_failed ? 1 : 0;
      return reportJobYield('goal_scope_propose_nightly', {
        attempted,
        succeeded: attempted - result.llm_failed,
        failed: result.llm_failed,
      });
    } catch (err) {
      console.error('[goal_scope_propose_nightly] failed', err);
      throw err;
    }
  };
}
