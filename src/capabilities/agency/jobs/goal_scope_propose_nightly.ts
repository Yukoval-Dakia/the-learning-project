// Station 2B / YUK-186 — nightly goal-scope propose handler.
//
// Structurally a clone of knowledge_edge_propose_nightly.ts: a thin
// candidate-picker + dedup gate + ONE call into runGoalScopeAndWrite (the
// PROPOSE half, ../server/goals/scope.ts). The cron does NOT re-implement the
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

import { listActiveGoals } from '@/capabilities/agency/server/goals/queries';
import { runGoalScopeAndWrite } from '@/capabilities/agency/server/goals/scope';
import { resolveSubjectKnowledgeIds } from '@/capabilities/knowledge/server/domain';
// M5 seam（YUK-319 T2 记录）：跨包深 import knowledge 内部模块——M5 收紧包边界时
// 应换走 knowledge 包对外导出面；M4 等价平移期原样保留。
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
import type { Db } from '@/db/client';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { getDefaultSubjectRegistry, resolveSubjectProfile } from '@/subjects/profile';
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
  /**
   * YUK-779 — 1 when runGoalScopeAndWrite SWALLOWED a fault (`ok === false`), else 0.
   * Without it, `proposed: 0` covers both "the model had nothing to propose" and
   * "the LLM call blew up", so a 限流风暴 reads as a normal quiet night.
   */
  llm_failed: number;
  /**
   * YUK-779 — 1 once runGoalScopeAndWrite was actually CALLED, else 0.
   *
   * Deliberately NOT `considered`: gate 2 (已有 live goal) and gate 3 (已有 pending
   * 提案) both return `considered: 1` while short-circuiting **before** the LLM half
   * ever runs. Feeding `considered` into the yield tally would claim a fallible unit
   * was attempted on nights where nothing was ever called — breaking the
   * `attempted === succeeded + failed` invariant that the whole 判据 rests on
   * (job-yield.ts). See the handler below for the exact hazard that creates.
   */
  llm_attempted: number;
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
    llm_failed: 0,
    // Every early return spreads `empty`, so each pre-LLM gate (no weak domain /
    // live goal / pending proposal) correctly reports "the model was never called".
    llm_attempted: 0,
  };

  // PRE-LLM reads run OUTSIDE runGoalScopeAndWrite's swallow (D7 / F-1): a throw
  // here is a legit retryable DB error (the builder rethrows → pg-boss retries),
  // NOT a logged skip. Do NOT wrap these in a catch-all.
  const tree = await loadTreeSnapshot(db);

  // Mastery-based candidate selection (watermark-independent). Pick the selectable
  // domain with the most weak nodes; registry 序作确定性 tie-break（first-wins，
  // strict `>` 保先序）。YUK-600（v2 §6 两分述）：
  //   - **候选源必换** getSelectableSubjectIds()——custom 科目 hydrate 后自动入池
  //     （worker ≤60s 可见）；分类器合同不改（确定性挑选）。
  //   - **≥5 KC gate**：resolveSubjectKnowledgeIds(candidate).length >= 5 才有
  //     资格（PR-0 排根后自动纯内容计数——空科目/只有根的科目不值得夜间 LLM 提案）。
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
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
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
    // YUK-779: surface the swallow instead of letting it collapse into proposed:0.
    // This is the ONLY return that sets llm_attempted — the call above just happened.
    llm_attempted: 1,
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
      // YUK-779 — the fallible unit is the single LLM half, counted by `llm_attempted`.
      //
      // Must NOT be `considered` (PR #1076 review): gates 2/3 return `considered: 1`
      // while short-circuiting before the LLM ever runs. Using it would report
      // {attempted:1, succeeded:1, failed:0} on a gated night — level `ok` instead of
      // the truthful `idle`. Benign while `ok` and `idle` are both silent, but it
      // breaks the attempted === succeeded + failed invariant, and it is exactly the
      // arithmetic that would go live the moment the owner flips `stalled → throw`
      // (PR §4) or anything starts distinguishing `idle` from `ok`.
      return reportJobYield('goal_scope_propose_nightly', {
        attempted: result.llm_attempted,
        succeeded: result.llm_attempted - result.llm_failed,
        failed: result.llm_failed,
      });
    } catch (err) {
      console.error('[goal_scope_propose_nightly] failed', err);
      throw err;
    }
  };
}
