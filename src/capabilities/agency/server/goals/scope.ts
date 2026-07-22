// YUK-143 / ADR-0025 — North-Star GoalScopeTask orchestrator (ND-2).
//
// Mirrors src/server/knowledge/propose_edge.ts: load a knowledge-grid snapshot
// (nodes + mastery + mesh edges), run GoalScopeTask (single structured-output
// call, no tool loop), validate, and write a `goal_scope` AiProposal. The user
// confirms/edits/dismisses it in the existing proposal inbox; accepting it
// materializes the `goal` row (see accept.ts). Everything is evidence-logged
// and reversible (ADR-0025). Any failure is swallowed + logged so a transient
// LLM outage never breaks the goal-create entry point.

import { newId } from '@/core/ids';
import { z } from 'zod';

// M5 seam（YUK-319 T2 记录）：跨包深 import knowledge 内部模块——M5 收紧包边界时
// 应换走 knowledge 包对外导出面；M4 等价平移期原样保留。
import { writeRetryableAiFailureLedger } from '@/capabilities/knowledge/server/ai_failure_log';
import { loadTreeSnapshot } from '@/capabilities/knowledge/server/tree';
import type { Db } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import type { GoalScopeIntent } from '@/kernel/task-intents';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import type { ToolContext } from '@/server/ai/tools/types';
import { writeAiProposal } from '@/server/proposals/writer';
import { type SubjectProfile, resolveSubjectProfile } from '@/subjects/profile';

const GoalScopeOutputSchema = z.object({
  scope_knowledge_ids: z.array(z.string().min(1)).default([]),
  sequence_hint: z.number().int().min(0).default(0),
  reasoning: z.string().min(1).max(4000),
});
export type GoalScopeOutput = z.infer<typeof GoalScopeOutputSchema>;

export interface RunGoalScopeAndWriteParams {
  db: Db;
  goalTitle: string;
  /** nullable — cross-subject goals are allowed (ND-1). */
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
}

const EMPTY_RESULT: RunGoalScopeAndWriteResult = {
  proposal_id: null,
  goal_id: null,
  scope_count: 0,
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
  try {
    const prepared = await buildGoalScopePreparation(params.db, {
      goal_title: params.goalTitle,
      subject_id: params.subjectId,
    });
    if (!prepared) return { ...EMPTY_RESULT };
    const { input, tree } = prepared;

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

    return { proposal_id: proposalId, goal_id: goalId, scope_count: scope.length };
  } catch (err) {
    console.error('runGoalScopeAndWrite: failed (no proposal written)', err);
    await writeRetryableAiFailureLedger(params.db, 'GoalScopeTask');
    return { ...EMPTY_RESULT };
  }
}

export function parseGoalScopeOutput(text: string): GoalScopeOutput {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('parseGoalScopeOutput: no JSON object found in text');
  }
  const slice = text.slice(start, end + 1);
  let json: unknown;
  try {
    json = JSON.parse(slice);
  } catch (e) {
    throw new Error(`parseGoalScopeOutput: JSON.parse failed: ${(e as Error).message}`);
  }
  return GoalScopeOutputSchema.parse(json);
}
