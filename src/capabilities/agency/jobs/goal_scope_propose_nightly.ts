// Nightly goal-scope propose handler.
//
// A thin candidate-picker + dedup gate + ONE call into runGoalScopeAndWrite (the PROPOSE
// half, ../server/goals/scope.ts), which owns the snapshot load, the structured-output
// GoalScopeTask call, parse, id-subset filter, writeAiProposal and failure swallowing.
//
// Per run: rank KNOWN domains by weak-node count (watermark-independent, over the same
// tree snapshot the producer reads), walk them in order through the dedup gates (live
// goal, pending proposal, dismiss cooldown) and call the producer at most ONCE, on the
// first candidate that clears every gate.
//
// Failure asymmetry: the LLM/producer half swallows faults into EMPTY_RESULT. The pre-LLM
// DB reads run OUTSIDE that swallow — a throw there is a legit retryable DB fault that must
// propagate so pg-boss retries. Do NOT wrap the pre-LLM reads in a catch-all.

import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import { runGoalScopeAndWrite } from '@/capabilities/agency/server/goals/scope';
import type { Db } from '@/db/client';
import { ai_task_runs, event } from '@/db/schema';
import { listActiveGoals } from '@/kernel/read-models/active-goal-scope';
import { loadTreeSnapshot } from '@/kernel/read-models/knowledge-graph';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import { type JobYieldOutput, reportJobYield } from '@/server/boss/job-yield';
import { getDefaultSubjectRegistry, resolveSubjectProfile } from '@/subjects/profile';
import { type TaskTextRunFn, makeRunTaskFn } from '../server/ai-runtime';
import { loadDismissedGoalScopeSubjects, loadPendingGoalScopeSubjects } from './goal_scope_dedup';

type DepsOverride = {
  runTaskFn?: TaskTextRunFn;
  /**
   * Stable per-execution id — the real handler supplies `jobs[0].id`. Direct
   * callers (demo, tests) omit it and get a fresh proposal id (unchanged
   * behavior). Required for the cross-retry guard to engage.
   */
  executionId?: string;
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

/**
 * Deterministic proposal event id for one pg-boss execution. A retry reuses the
 * same `job.id`, so the derived id lets the pre-flight check find the
 * already-committed proposal rather than writing a duplicate.
 */
function goalScopeProposalEventId(executionId: string): string {
  const digest = createHash('sha256').update(executionId).digest('hex').slice(0, 32);
  return `goal_scope_proposal_${digest}`;
}

/**
 * Deterministic ai_task_runs PK for one pg-boss execution — the model owner's
 * pre-send running-row insert fail-closes a concurrent duplicate, so deriving
 * it from `job.id` makes the paid call at-most-once per execution.
 */
function goalScopeTaskRunId(executionId: string): string {
  const digest = createHash('sha256').update(executionId).digest('hex').slice(0, 32);
  return `goal_scope_task_run_${digest}`;
}

/**
 * Paid-at-most-once guard. If an `ai_task_runs` row already exists for this
 * execution's deterministic taskRunId, an earlier delivery already claimed —
 * and possibly paid for — the model call. NEVER resend, regardless of
 * `status` (running / succeeded / failed / unknown): the proposal guard below
 * recovers a committed proposal; a task-run row without a proposal means the
 * paid output may be unrecoverable and we fail closed rather than repurchase.
 * Fail closed on a row whose task_kind is not GoalScopeTask (a same-PK
 * collision under a different kind — should never happen).
 */
async function loadPriorTaskRun(
  db: Db,
  executionId: string,
): Promise<'none' | 'goal_scope' | 'foreign'> {
  const id = goalScopeTaskRunId(executionId);
  const [row] = await db
    .select({ task_kind: ai_task_runs.task_kind })
    .from(ai_task_runs)
    .where(eq(ai_task_runs.id, id))
    .limit(1);
  if (!row) return 'none';
  return row.task_kind === 'GoalScopeTask' ? 'goal_scope' : 'foreign';
}

/**
 * pg-boss redelivery after a lost ACK reuses `job.id`. If the derived proposal
 * event id already exists, the earlier delivery DID commit a proposal — return
 * true so the caller returns the committed id with zero model attempt instead
 * of letting pending-dedup fall through to a different subject and
 * repurchasing a proposal. Fail closed on a row that does not look like our
 * goal_scope proposal (should never happen).
 */
async function hasCommittedProposal(db: Db, executionId: string): Promise<boolean> {
  const id = goalScopeProposalEventId(executionId);
  const [row] = await db
    .select({ action: event.action, payload: event.payload })
    .from(event)
    .where(eq(event.id, id))
    .limit(1);
  if (!row) return false;
  const kind = (row.payload as { ai_proposal?: { kind?: unknown } } | null)?.ai_proposal?.kind;
  if (row.action !== 'experimental:proposal' || kind !== 'goal_scope') {
    throw new Error(
      `goal_scope_propose_nightly: deterministic event ${id} exists but is not a goal_scope proposal`,
    );
  }
  return true;
}

type TreeNodeShape = {
  effective_domain: string | null;
  role: 'kc' | 'goal' | 'container';
  mastery: number | null;
  evidence_count: number;
};

/**
 * Weak = a real KC row with actual evidence and a measured mastery below 0.55.
 * A node with no projection (mastery null / evidence_count 0) is UNKNOWN, not weak —
 * missing evidence must not manufacture weak evidence.
 */
export function hasWeakNodeInDomain(tree: TreeNodeShape[], domain: string): boolean {
  return countWeakNodesInDomain(tree, domain) > 0;
}

/** Weak nodes in a domain (same 0.55 convention); drives candidate selection. */
export function countWeakNodesInDomain(tree: TreeNodeShape[], domain: string): number {
  return tree.filter(
    (n) =>
      n.effective_domain === domain &&
      n.role === 'kc' &&
      n.evidence_count > 0 &&
      n.mastery !== null &&
      n.mastery < 0.55,
  ).length;
}

/**
 * Walk KNOWN domains by weak-node count (desc, registry order breaks ties) through the
 * dedup gates and emit ONE goal_scope proposal for the first candidate not already
 * covered by a live goal / pending proposal / dismiss cooldown. Cap = 1 producer
 * call/run — a swallowed producer fault ends the run rather than paying for a second
 * subject. No qualified candidate → no-op (skipped_no_weak).
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

  // ── Cross-retry guards: run BEFORE every candidate/model read ──
  //
  // Two execution-scoped rows make the paid call at-most-once per job.id.
  // (a) ai_task_runs PK — claimed by the model owner BEFORE the provider is
  //     queried. If a row exists, an earlier delivery already sent (or is
  //     sending) the model call: never resend. A committed proposal is
  //     recovered by guard (b); a task-run row WITHOUT a proposal means the
  //     paid output may be unrecoverable → fail closed, do NOT treat as a
  //     successful paid round.
  // (b) deterministic proposal event id — recover the already-committed
  //     proposal after a lost ACK so pending-dedup cannot fall through to a
  //     different subject and repurchase.
  if (deps.executionId) {
    const prior = await loadPriorTaskRun(db, deps.executionId);
    if (prior === 'foreign') {
      throw new Error(
        `goal_scope_propose_nightly: deterministic task_run ${goalScopeTaskRunId(deps.executionId)} exists under a foreign task_kind`,
      );
    }
    if (prior === 'goal_scope') {
      // The model call was already claimed/sent for this execution. Recover a
      // committed proposal if present; otherwise the paid output is
      // unrecoverable → report a swallowed-failure no-proposal result (NOT a
      // success) so the run does not read as a fresh paid round.
      if (await hasCommittedProposal(db, deps.executionId)) {
        return {
          ...empty,
          considered: 1,
          proposed: 1,
          proposal_id: goalScopeProposalEventId(deps.executionId),
        };
      }
      return {
        ...empty,
        considered: 1,
        // The provider may already have been paid; the model output is
        // unrecoverable, so surface as a swallowed failure rather than idle.
        llm_attempted: 1,
        llm_failed: 1,
      };
    }
    // No task-run row: nothing was ever sent. Still check for a committed
    // proposal (defensive — a proposal cannot exist without a task run, but
    // the guard is cheap and keeps the two invariants independent).
    if (await hasCommittedProposal(db, deps.executionId)) {
      return {
        ...empty,
        considered: 1,
        proposed: 1,
        proposal_id: goalScopeProposalEventId(deps.executionId),
      };
    }
  }

  // These reads run OUTSIDE runGoalScopeAndWrite's swallow: a throw is a retryable DB
  // error (pg-boss retries), NOT a logged skip. Do NOT wrap them in a catch-all.
  const tree = await loadTreeSnapshot(db);

  // Count each selectable domain's weak nodes once; registry position is the
  // deterministic tie-break. A candidate needs ≥5 KCs — thin or root-only subjects
  // are not worth a nightly LLM proposal.
  const ranked: { domain: string; weak: number; registryOrder: number }[] = [];
  let registryOrder = 0;
  for (const candidate of getDefaultSubjectRegistry().getSelectableSubjectIds()) {
    const kcs = await resolveSubjectKnowledgeIds(db, candidate);
    if (kcs.length >= 5) {
      // fan-out gate：内容太薄不提案
      const weak = countWeakNodesInDomain(tree, candidate);
      if (weak > 0) ranked.push({ domain: candidate, weak, registryOrder });
    }
    registryOrder++;
  }
  // Sort by weak count desc, then registry order asc — no recounting.
  ranked.sort((a, b) => b.weak - a.weak || a.registryOrder - b.registryOrder);

  // No known domain has any weak node → nothing to propose; skip the dedup reads.
  if (ranked.length === 0) return { ...empty, skipped_no_weak: 1 };

  const activeGoals = await listActiveGoals(db);
  const pendingSubjects = await loadPendingGoalScopeSubjects(db);
  const dismissedSubjects = await loadDismissedGoalScopeSubjects(db);

  // Apply the dedup gates in ranked order; a gated candidate yields to the next one.
  let sawExistingGoal = false;
  let sawPending = false;
  for (const { domain } of ranked) {
    // subjectId == domain, matching how the goal row stores subject_id and how
    // Dreaming / Coach read it; the profile supplies the title.
    const subjectId = domain;

    // Gate 2: skip subject with a live goal (same additive read Dreaming uses).
    if (activeGoals.some((g) => g.subject_id === subjectId)) {
      sawExistingGoal = true;
      continue;
    }

    // Gate 3: skip subject with a pending goal_scope proposal. Its decision query has
    // no subject_kind filter (see goal_scope_dedup) — adding one matches zero rows.
    // Gate 3.5: dismiss-churn 冷却——冷却窗内被 dismiss 的 subject 不重提；
    // skipped_pending 计数复用（同「今晚不提」语义桶，不新增 result 字段）。
    if (pendingSubjects.has(subjectId) || dismissedSubjects.has(subjectId)) {
      sawPending = true;
      continue;
    }

    // First ungated candidate: the LLM half is swallow-safe — runGoalScopeAndWrite's
    // internal try/catch absorbs LLM/key/runner throws → EMPTY_RESULT, proposed:0.
    const profile = resolveSubjectProfile(domain);
    const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(db);
    const result = await runGoalScopeAndWrite({
      db,
      // A deterministic displayName placeholder the user edits in the inbox before
      // accepting — NOT a name-resolution system; displayName must be non-empty.
      goalTitle: profile.displayName || subjectId,
      subjectId,
      runTaskFn,
      subjectProfile: profile,
      proposalId: deps.executionId ? goalScopeProposalEventId(deps.executionId) : undefined,
      taskRunId: deps.executionId ? goalScopeTaskRunId(deps.executionId) : undefined,
    });

    return {
      ...empty,
      considered: 1,
      proposed: result.proposal_id ? 1 : 0,
      skipped_existing_goal: sawExistingGoal ? 1 : 0,
      skipped_pending: sawPending ? 1 : 0,
      proposal_id: result.proposal_id,
      // Surface the swallow instead of letting it collapse into proposed:0. Not
      // hardcoded 1: runGoalScopeAndWrite can return before reaching the model (empty
      // tree → `!prepared`), so the flag must come from it.
      llm_attempted: result.llm_attempted ? 1 : 0,
      llm_failed: result.ok ? 0 : 1,
    };
  }

  // Every weak domain was gated → nothing proposed tonight. `considered` reports a
  // qualified candidate existed; the skip flags record which gates fired (both can be
  // 1 when different candidates hit different gates).
  return {
    ...empty,
    considered: 1,
    skipped_existing_goal: sawExistingGoal ? 1 : 0,
    skipped_pending: sawPending ? 1 : 0,
  };
}

export function buildGoalScopeProposeNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<JobYieldOutput> {
  // Capability jobs are mounted centrally with batchSize:1
  // (register-capability-jobs.ts); one handler invocation owns exactly one job id.
  return async (jobs) => {
    try {
      const executionId = jobs[0]?.id;
      if (!executionId) {
        throw new Error('goal_scope_propose_nightly: handler invoked without a pg-boss job id');
      }
      const result = await runGoalScopeProposeNightly(db, { executionId });
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
