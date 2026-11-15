// North-Star GoalScopeTask orchestrator. Loads a knowledge-grid snapshot (nodes +
// mastery + mesh edges), runs GoalScopeTask (single structured-output call, no tool
// loop), validates, and writes a `goal_scope` AiProposal. The user confirms/edits/
// dismisses it in the proposal inbox; accepting materializes the `goal` row (accept.ts).
// Any failure is swallowed + logged so a transient LLM outage never breaks goal-create.

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { knowledge_edge } from '@/db/schema';
import { and, inArray } from 'drizzle-orm';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { loadTreeSnapshot } from '@/kernel/read-models/knowledge-graph';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
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
  /**
   * The concrete goal title parsed from the learner's words (「三角函数」 from
   * 「我想把三角函数学好」) — what the proposal/goal row stores as `title`. For
   * the nightly it is the system suggestion (see caller); never a bare subject
   * displayName when real learner words exist.
   */
  goalTitle: string;
  /**
   * The learner's verbatim words (NFKC, whitespace-collapsed) that produced
   * `goalTitle`, when a real learner turn supplied them. Persisted on the
   * proposal payload for provenance and receipt matching; absent for
   * system-suggested goals (nightly).
   */
  learnerWords?: string;
  /** nullable — cross-subject goals are allowed. */
  subjectId?: string | null;
  runTaskFn: TaskTextRunFn;
  env?: unknown;
  subjectProfile?: SubjectProfile;
  /**
   * Deterministic proposal event id for cross-retry dedup. The nightly passes
   * `goal_scope_proposal_<sha256(bossJobId)>` so a pg-boss retry (same job.id)
   * detects the already-written pending proposal instead of repurchasing a
   * proposal. Omit → a fresh `newId()` (direct callers, unchanged).
   */
  proposalId?: string;
  /**
   * Stable ai_task_runs PK for cross-retry paid-at-most-once. The nightly
   * passes `goal_scope_task_run_<sha256(bossJobId)>`; runner honors it on
   * attempt 1 and the pre-send `ai_task_runs` running-row PK insert fail-closes
   * a concurrent duplicate. Omit → runner generates a fresh id (direct
   * callers, unchanged).
   */
  taskRunId?: string;
  /**
   * Internal: the throwing core mutates this marker around the `runTaskFn` call —
   * `started` the instant before invoking it, `returned` once it resolves. A
   * caller uses it to tell a pre-call fault (config/admission/preparation) from
   * a post-call fault (parse/proposal-write after the model ran); it does NOT
   * prove the provider was charged — that is the runner's job via AgentRunError.
   */
  __attempt?: { started: boolean; returned: boolean };
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

/**
 * Bound the GoalScopeTask grid to the selected subject subtree. `subjectId` is
 * resolved to canonical node ids via the same read-model the live-goal readers
 * use; edges are fetched only for pairs that live inside that subtree. An
 * unresolvable or empty subject yields `null` so the caller surfaces an honest
 * clarify rather than scanning the whole tree.
 */
async function loadSubjectSubtreeGrid(db: Db, subjectId: string) {
  const memberIds = new Set(await resolveSubjectKnowledgeIds(db, subjectId));
  if (memberIds.size === 0) return null;
  const tree = await loadTreeSnapshot(db, subjectId);
  const nodes = tree.filter((node) => memberIds.has(node.id));
  if (nodes.length === 0) return null;
  const nodeIds = new Set(nodes.map((n) => n.id));
  const ids = [...nodeIds];
  const edges = await db
    .select({
      from_knowledge_id: knowledge_edge.from_knowledge_id,
      to_knowledge_id: knowledge_edge.to_knowledge_id,
      relation_type: knowledge_edge.relation_type,
    })
    .from(knowledge_edge)
    .where(
      and(
        inArray(knowledge_edge.from_knowledge_id, ids),
        inArray(knowledge_edge.to_knowledge_id, ids),
      ),
    );
  return { nodes, edges };
}

async function buildGoalScopePreparation(db: Db, intent: GoalScopeIntent) {
  const subjectId = intent.subject_id ?? null;
  // The grid is always the selected subject's subtree — never the whole tree
  // and never an arbitrary substitute. A null/empty/unresolvable subject yields
  // no preparation so the caller surfaces an honest clarify instead of silently
  // proposing over a guessed domain (nightly passes an explicit subjectId and
  // never reaches this no-subject path).
  const subtree = subjectId ? await loadSubjectSubtreeGrid(db, subjectId) : null;
  if (!subtree) return null;
  const { nodes, edges } = subtree;
  return {
    input: {
      goal_title: intent.goal_title,
      subject_id: subjectId,
      grid: {
        nodes: nodes.map((node) => ({
          id: node.id,
          name: node.name,
          effective_domain: node.effective_domain,
          role: node.role,
          mastery: node.mastery,
          evidence_count: node.evidence_count,
        })),
        edges,
      },
    },
    nodes,
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

/**
 * Throwing producer core: runs the task, fail-closes invalid output, and writes
 * the proposal. Distinct from `runGoalScopeAndWrite`, which swallows every fault
 * for its job/tool callers. A paid request must see the real error — an
 * `AgentRunError` (provider send, unknown terminal) or a post-provider write
 * fault — so the paid seam can classify it instead of flattening it to a
 * repurchasable `provider_failed`.
 *
 * It mutates `params.__attempt` around the `runTaskFn` call — `started` before
 * invoking, `returned` once it resolves — so the paid seam can tell a pre-send
 * config/admission fault from a post-send parse/write fault. The marker only
 * bounds the call site; it never proves the provider was charged.
 */
export async function produceGoalScope(
  params: RunGoalScopeAndWriteParams,
): Promise<RunGoalScopeAndWriteResult> {
  const prepared = await buildGoalScopePreparation(params.db, {
    goal_title: params.goalTitle,
    subject_id: params.subjectId,
  });
  if (!prepared) return { ...EMPTY_RESULT };
  const { input, nodes } = prepared;

  if (params.__attempt) params.__attempt.started = true;
  const result = await params.runTaskFn('GoalScopeTask', input, {
    subjectProfile: params.subjectProfile,
    ...(params.taskRunId !== undefined ? { taskRunId: params.taskRunId } : {}),
  });
  if (params.__attempt) params.__attempt.returned = true;
  const parsed = parseGoalScopeOutput(result.text);

  // Fail closed on hallucinated / out-of-subtree ids: every cited id must be
  // a real node inside the (bounded) grid the model was shown. A single
  // invalid id discards the whole output rather than silently narrowing it.
  const validNodeIds = new Set(nodes.map((n) => n.id));
  const cited = parsed.scope_knowledge_ids;
  if (cited.some((id) => !validNodeIds.has(id))) {
    throw new Error('GoalScopeTask output references knowledge ids outside the selected subtree');
  }
  // An empty scope is a degenerate goal — it would write a proposal covering
  // nothing and only add inbox noise. Fail closed on it too, so every
  // materialized proposal carries a real, ordered point list.
  if (cited.length === 0) {
    throw new Error('GoalScopeTask output has an empty scope_knowledge_ids');
  }
  let scope = cited;

  // Ordered path is mandatory for the (now always non-empty) scope: the
  // product contract is a persisted per-point learn order, so a
  // scope_knowledge_ids without an ordered_scope that covers it exactly
  // (contiguous 1..N, no extras, no omissions, no duplicates) is a fail-
  // closed reject — never written as an unordered proposal. This also
  // fail-closes a model still emitting the pre-order shape (scope +
  // sequence_hint only).
  const ordered = parsed.ordered_scope;
  const orderedIds = ordered.map((p) => p.knowledge_id);
  const orders = ordered.map((p) => p.order).sort((a, b) => a - b);
  const coversScope =
    orderedIds.length === scope.length &&
    orderedIds.every((id) => validNodeIds.has(id) && scope.includes(id)) &&
    new Set(orderedIds).size === orderedIds.length &&
    orders.every((o, i) => o === i + 1);
  if (!coversScope) {
    throw new Error(
      'GoalScopeTask output must order the scope: ordered_scope missing or does not cover scope_knowledge_ids as contiguous 1..N',
    );
  }
  const orderedScope = [...ordered].sort((a, b) => a.order - b.order);
  // Persist the order in the materialized goal row through the frozen
  // scope_knowledge_ids array order (jsonb preserves array order).
  scope = orderedScope.map((p) => p.knowledge_id);

  const goalId = newId();
  const proposalId = await writeAiProposal(params.db, {
    id: params.proposalId,
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
        ...(params.learnerWords ? { learner_words: params.learnerWords } : {}),
        scope_knowledge_ids: scope,
        ordered_scope: orderedScope,
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
    llm_attempted: true,
  };
}

export async function runGoalScopeAndWrite(
  params: RunGoalScopeAndWriteParams,
): Promise<RunGoalScopeAndWriteResult> {
  // `attempt.started` is set the instant before the model call is invoked, so a
  // swallowed fault inside it still reports llm_attempted:true while a pre-call
  // no-op stays false — llm_attempted keeps its existing meaning ("the model
  // call was attempted"), the wrapper's established semantic.
  const attempt = { started: false, returned: false };
  try {
    const produced = await produceGoalScope({ ...params, __attempt: attempt });
    return { ...produced, llm_attempted: produced.llm_attempted };
  } catch (err) {
    console.error('runGoalScopeAndWrite: failed (no proposal written)', err);
    await writeRetryableAiFailureLedger(params.db, 'GoalScopeTask');
    // `ok: false` plus `llm_attempted: true` distinguish this swallowed post-LLM fault
    // from the benign `!prepared` no-op above (both yield proposal_id: null).
    return { ...EMPTY_RESULT, ok: false, llm_attempted: attempt.started };
  }
}
