// North-Star GoalScopeTask orchestrator. Loads a knowledge-grid snapshot (nodes +
// mastery + mesh edges), runs GoalScopeTask (single structured-output call, no tool
// loop), validates, and writes a `goal_scope` AiProposal. The user confirms/edits/
// dismisses it in the proposal inbox; accepting materializes the `goal` row (accept.ts).
// Any failure is swallowed + logged so a transient LLM outage never breaks goal-create.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { loadTreeSnapshot } from '@/kernel/read-models/knowledge-graph';
import type { GoalScopeIntent } from '@/kernel/task-intents';
import type { ToolContext } from '@/kernel/tools/types';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';
import { parseGoalScopeOutput } from '../../tasks/goal-scope';
import { type TaskTextRunFn, writeRetryableAiFailureLedger } from '../ai-runtime';

export type { GoalScopeOutput } from '../../tasks/goal-scope';
// The GoalScope output contract is owned by the agency TaskSpec module; re-exported
// here for the existing db-test import surface.
export { GoalScopeOutputSchema, parseGoalScopeOutput } from '../../tasks/goal-scope';

export interface RunGoalScopeAndWriteParams {
  db: Db;
  goalTitle: string;
  /** nullable — cross-subject goals are allowed. */
  subjectId?: string | null;
  runTaskFn: TaskTextRunFn;
  env?: unknown;
  subjectProfile?: SubjectProfile;
}

export interface RunGoalScopeAndWriteResult {
  /** propose event id of the written goal_scope proposal, or null on no-op. */
  proposal_id: string | null;
  /** goal id reserved for materialization (carried in target.subject_id). */
  goal_id: string | null;
  scope_count: number;
  /**
   * Success/failure discriminant. `false` ONLY when this pipeline SWALLOWED an error
   * (its catch-all below).
   *
   * `proposal_id === null` is produced by BOTH the benign cold-start no-op (empty tree,
   * no LLM call) and a swallowed LLM/parse fault; without this flag the nightly job
   * reports `proposed: 0` for both. A benign no-op returns `ok: true` — the fallible
   * step returned normally without output.
   */
  ok: boolean;
  /**
   * True once GoalScopeTask was actually CALLED.
   *
   * This function also returns before the model when the knowledge tree is empty, with
   * `ok: true` and a zero result. The nightly's own `skipped_no_weak` gate shadows that
   * path today, but the flag stays exact: the shadowing depends on a different
   * function's gate ordering, and a TOCTOU can still reach it.
   */
  llm_attempted: boolean;
}

const EMPTY_RESULT: RunGoalScopeAndWriteResult = {
  proposal_id: null,
  goal_id: null,
  scope_count: 0,
  ok: true,
  // false by default — every early return stopped short of the model; only the live
  // path flips it, immediately before the call.
  llm_attempted: false,
};

async function buildGoalScopePreparation(db: Db, intent: GoalScopeIntent) {
  const tree = await loadTreeSnapshot(db);
  if (tree.length === 0) return null;
  const edges = await db
    .select({
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
      relation_type: knowledge_edge.relation_type,
    })
    .from(knowledge_edge);
  return {
    input: {
      goal_title: intent.goal_title,
      subject_id: intent.subject_id ?? null,
      grid: {
        nodes: tree.map((node) => ({
          id: node.id,
          name: node.name,
          effective_domain: node.effective_domain,
          mastery: node.mastery,
          evidence_count: node.evidence_count,
        })),
        edges,
      },
    },
    tree,
  };
}

export async function prepareGoalScopeTask(ctx: ToolContext, intent: GoalScopeIntent) {
  const prepared = await buildGoalScopePreparation(ctx.db, intent);
  if (!prepared) throw new Error('GoalScopeTask knowledge grid is empty');
  return {
    input: prepared.input,
    ctx: { subjectProfile: resolveSubjectProfile(intent.subject_id ?? null) },
  };
}

export async function runGoalScopeAndWrite(
  params: RunGoalScopeAndWriteParams,
): Promise<RunGoalScopeAndWriteResult> {
  // 必须在 try 之外：catch 也要如实回答「刚才到底调没调模型」，否则一个发生在 LLM
  // 之前的吞掉的故障会被报成 idle，把真实吞错隐形。
  let llmAttempted = false;
  try {
    const prepared = await buildGoalScopePreparation(params.db, {
      goal_title: params.goalTitle,
      subject_id: params.subjectId,
    });
    if (!prepared) return { ...EMPTY_RESULT };
    const { input, tree } = prepared;

    // 紧挨调用之前置位，成功与吞错两条路都能如实回答「试过」。
    llmAttempted = true;
    const result = await params.runTaskFn('GoalScopeTask', input, {
      subjectProfile: params.subjectProfile,
    });
    const parsed = parseGoalScopeOutput(result.text);

    // Drop hallucinated node ids — keep only nodes that exist in the grid.
    const validNodeIds = new Set(tree.map((n) => n.id));
    const scope = parsed.scope_knowledge_ids.filter((id) => validNodeIds.has(id));

    const goalId = newId();
    const proposalId = await writeAiProposal(params.db, {
      actor_ref: 'goal_scope',
      outcome: 'partial',
      payload: {
        kind: 'goal_scope',
        target: { subject_kind: 'goal', subject_id: goalId },
        reason_md: parsed.reasoning,
        evidence_refs: [],
        proposed_change: {
          title: params.goalTitle,
          subject_id: params.subjectId ?? null,
          scope_knowledge_ids: scope,
          sequence_hint: parsed.sequence_hint,
          reasoning: parsed.reasoning,
        },
        cooldown_key: `goal_scope:${goalId}`,
      },
      task_run_id: result.task_run_id ?? null,
      cost_usd: result.cost_usd,
      created_at: new Date(),
    });

    return {
      proposal_id: proposalId,
      goal_id: goalId,
      scope_count: scope.length,
      ok: true,
      // 从局部量派生而非硬编码 true：其余出口（EMPTY_RESULT 默认、`!prepared` 早返、
      // catch-all）都从 llmAttempted 取值，硬编码会成为同一含义的第二个真源。
      llm_attempted: llmAttempted,
    };
  } catch (err) {
    console.error('runGoalScopeAndWrite: failed (no proposal written)', err);
    await writeRetryableAiFailureLedger(params.db, 'GoalScopeTask');
    // `ok: false` plus `llm_attempted: true` distinguish this swallowed post-LLM fault
    // from the benign `!prepared` no-op above (both yield proposal_id: null).
    return { ...EMPTY_RESULT, ok: false, llm_attempted: llmAttempted };
  }
}
