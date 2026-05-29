// Wave 5 / T-D6/B — coach_daily pg-boss handler.
//
// Mirrors src/server/boss/handlers/dreaming_nightly.ts. Builds the COACH
// allowlist MCP bridge, runs `CoachTask`, and writes trigger + scan events
// (`experimental:trigger_coach_scan` / `experimental:coach_scan`).

import { createId } from '@paralleldrive/cuid2';
import type { Job } from 'pg-boss';

import { type TodayPlanT, parseTodayPlan } from '@/core/schema/coach';
import type { Db } from '@/db/client';
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
// YUK-143 / ADR-0025 — North-Star: feed active goals into the Coach input so it
// can add a goal-oriented strand. Purely ADDITIVE (ND-5): the FSRS-due / review
// backbone and other capture tasks are untouched; goals only add direction.
import { type ActiveGoal, listActiveGoals } from '@/server/goals/queries';
import { type ProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';

export const COACH_MAX_PROPOSALS = 5;
// YUK-143 / ADR-0025 — North-Star goal strand guidance appended to the Coach
// objective. ND-5 is stated explicitly: the goal strand is ADDITIVE only — it
// must NOT suppress FSRS-due reviews, hide other capture tasks, preempt the
// daily quota, or change due times. When active_goals is present the model adds
// a `goal_strand` (each item tagged `serves_goal_id` + `knowledge_ids`) and
// lists the addressed goals in `goal_ids`, distributing effort across goals
// (round-robin + weakest-scope first). When empty, omit the strand.
const COACH_GOAL_STRAND_GUIDANCE =
  ' If active_goals are provided, additionally add a goal-oriented strand: set TodayPlan.goal_ids to the goals you address and add goal_strand items (each tagged serves_goal_id + knowledge_ids). Distribute attention across active goals (round-robin + weakest-scope first). CRITICAL: the goal strand is purely additive direction — it must NOT suppress or replace the FSRS-due review backbone, hide other capture tasks, preempt the daily review quota, or change any due times. If there are no active goals, omit the goal strand.';
export const COACH_DAILY_OBJECTIVE = `Produce a TodayPlan for the user via the provided DomainTools. Only write proposals (defer / split / relearn / archive / completion / maintenance); never mutate user data directly. Prefer doing nothing if the day has no actionable adjustments.${COACH_GOAL_STRAND_GUIDANCE}`;
export const COACH_WEEKLY_OBJECTIVE = `Produce a weekly TodayPlan with a \`weekly_reflection\` summary plus any plan adjustments / maintenance proposals via propose_* tools. Only write proposals; never mutate user data directly.${COACH_GOAL_STRAND_GUIDANCE}`;

export interface CoachRunResult {
  processed: number;
  proposals_created: number;
  pending_after: number;
  task_run_id?: string;
  tool_context_task_run_id: string;
}

type ProposalSnapshotRow = Pick<ProposalInboxRow, 'id' | 'status'>;
type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: {
    db: Db;
    mcpServers?: Record<string, SdkMcpServer>;
    allowedTools?: string[];
  },
) => Promise<RunTaskResult>;
type ListProposalInboxRowsFn = (db: Db) => Promise<ProposalSnapshotRow[]>;
type BuildMcpServerFn = typeof buildMcpServerFromRegistry;
type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;
// YUK-143 / ADR-0025 — swappable active-goals reader (DB tests inject fixtures).
type ListActiveGoalsFn = (db: Db) => Promise<ActiveGoal[]>;

export type CoachRunKind = 'daily' | 'weekly';

export interface CoachRunDeps {
  runAgentTaskFn?: RunAgentTaskFn;
  listProposalInboxRowsFn?: ListProposalInboxRowsFn;
  buildMcpServerFn?: BuildMcpServerFn;
  writeEventFn?: WriteEventFn;
  // YUK-143 / ADR-0025 — defaults to listActiveGoals; goals feed the additive
  // goal strand only and never touch the review backbone (ND-5).
  listActiveGoalsFn?: ListActiveGoalsFn;
  now?: () => Date;
}

function buildCoachInput(
  runKind: CoachRunKind,
  now: Date,
  beforeRows: ProposalSnapshotRow[],
  objective: string,
  activeGoals: ActiveGoal[],
) {
  return {
    run_kind: runKind,
    now: now.toISOString(),
    pending_proposals_before: beforeRows.filter((row) => row.status === 'pending').length,
    objective,
    // YUK-143 / ADR-0025 — active goals for the additive goal strand (ND-5).
    // Ordered by sequence_hint then created_at (listActiveGoals). Empty array
    // when no goals exist → model omits the strand, plan is unchanged.
    active_goals: activeGoals.map((g) => ({
      id: g.id,
      title: g.title,
      subject_id: g.subject_id,
      scope_knowledge_ids: g.scope_knowledge_ids,
      sequence_hint: g.sequence_hint,
    })),
    budget: {
      max_tool_calls: 12,
      max_proposals: COACH_MAX_PROPOSALS,
      stop_when_no_actionable_proposal: true,
    },
    proposal_policy: {
      prefer_existing_proposal_tools: true,
      avoid_duplicates: true,
      no_silent_writes: true,
    },
    output_schema: {
      kind: 'TodayPlan',
      hint: 'Return a JSON object with daily_focus, review_session_proposal, plan_adjustments[], maintenance_proposals[]. Weekly runs additionally set weekly_reflection. When active_goals are present, also set goal_ids[] and goal_strand[] (each item: serves_goal_id, knowledge_ids[], focus) — additive only, never replacing review_session_proposal (ND-5).',
    },
  };
}

export async function runCoach(
  db: Db,
  runKind: CoachRunKind,
  deps: CoachRunDeps = {},
): Promise<CoachRunResult> {
  const now = deps.now?.() ?? new Date();
  const listRows = deps.listProposalInboxRowsFn ?? listProposalInboxRows;
  const run = deps.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = deps.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const write = deps.writeEventFn ?? writeEvent;
  const listGoals = deps.listActiveGoalsFn ?? listActiveGoals;
  const triggerActorRef = runKind === 'daily' ? 'nightly_coach' : 'weekly_coach';
  const objective = runKind === 'daily' ? COACH_DAILY_OBJECTIVE : COACH_WEEKLY_OBJECTIVE;

  const beforeRows = await listRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  // YUK-143 / ADR-0025 — read active goals for the additive goal strand. This is
  // a read-only ADD to the Coach signal set; it does not read the FSRS-due queue
  // or mutate any review state (ND-5).
  const activeGoals = await listGoals(db);
  const triggerEventId = `coach_trigger_${createId()}`;
  const toolContextTaskRunId = `coach_tool_${createId()}`;

  await write(db, {
    id: triggerEventId,
    actor_kind: 'cron',
    actor_ref: triggerActorRef,
    action: 'experimental:trigger_coach_scan',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: null,
    payload: {
      surface: 'coach',
      run_kind: runKind,
      pending_before: beforeRows.filter((row) => row.status === 'pending').length,
    },
    created_at: now,
  });

  try {
    const toolNames = resolveDomainToolNames('coach');
    let proposalWrites = 0;
    const mcpServer = buildMcpServer({
      ctx: {
        db,
        taskRunId: toolContextTaskRunId,
        callerActor: { kind: 'agent', ref: 'coach' },
        causedByEventId: triggerEventId,
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames,
      taskKind: 'CoachTask',
      beforeExecute: (tool) => {
        if (tool.effect !== 'propose' && tool.effect !== 'write') return undefined;
        if (proposalWrites >= COACH_MAX_PROPOSALS) {
          return `coach proposal cap reached (${COACH_MAX_PROPOSALS}); stop creating proposals in this run`;
        }
        proposalWrites += 1;
        return undefined;
      },
    });

    const taskResult = await run(
      'CoachTask',
      buildCoachInput(runKind, now, beforeRows, objective, activeGoals),
      {
        db,
        mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
        allowedTools: [...resolveMcpAllowedTools('coach')],
      },
    );

    const afterRows = await listRows(db);
    const pendingAfter = afterRows.filter((row) => row.status === 'pending').length;
    const proposalsCreated = afterRows.filter((row) => !beforeIds.has(row.id)).length;

    // Parse the CoachTask's TodayPlan JSON out of `taskResult.text`. The
    // `/api/today/copilot-summary` reader looks for `payload.daily_focus`
    // (and `payload.today_plan.daily_focus`) on the latest
    // `experimental:coach_scan` event — so we need to persist the plan here
    // for the drawer summary slot to render Coach's actual output. If the
    // model returned non-JSON or schema-invalid output, fall through to the
    // placeholder copy (copilot-summary handles the null/missing case).
    const todayPlan = parseCoachOutputSafely(taskResult.text);

    await write(db, {
      id: `coach_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: 'coach',
      action: 'experimental:coach_scan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        run_kind: runKind,
        proposals_created: proposalsCreated,
        pending_after: pendingAfter,
        tool_context_task_run_id: toolContextTaskRunId,
        ...(todayPlan
          ? { today_plan: todayPlan, daily_focus: todayPlan.daily_focus }
          : { today_plan: null, plan_parse_error: true }),
      },
      caused_by_event_id: triggerEventId,
      task_run_id: taskResult.task_run_id,
      cost_micro_usd:
        taskResult.cost_usd === undefined ? null : Math.round(taskResult.cost_usd * 1_000_000),
      created_at: deps.now?.() ?? new Date(),
    });

    return {
      processed: 1,
      proposals_created: proposalsCreated,
      pending_after: pendingAfter,
      task_run_id: taskResult.task_run_id,
      tool_context_task_run_id: toolContextTaskRunId,
    };
  } catch (err) {
    await write(db, {
      id: `coach_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: 'coach',
      action: 'experimental:coach_scan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'failure',
      payload: {
        run_kind: runKind,
        error: err instanceof Error ? err.message : String(err),
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: triggerEventId,
      created_at: deps.now?.() ?? new Date(),
    });
    throw err;
  }
}

/**
 * Best-effort `TodayPlan` parse from a CoachTask raw text result. CoachTask's
 * registered prompt asks the model to emit a single JSON object matching the
 * `TodayPlan` schema, but live models sometimes wrap it in prose, code fences,
 * or partial JSON. We try a clean parse first, then a fenced-code extraction,
 * and finally return `null` so the downstream reader can fall back to the
 * placeholder copy instead of crashing the cron run.
 */
export function parseCoachOutputSafely(rawText: string): TodayPlanT | null {
  if (!rawText) return null;
  const candidates: string[] = [rawText];
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) candidates.unshift(fenceMatch[1]);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return parseTodayPlan(parsed);
    } catch {
      // Try the next candidate; final return below handles total failure.
    }
  }
  return null;
}

export function buildCoachDailyHandler(
  db: Db,
  deps: CoachRunDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runCoach(db, 'daily', deps);
    console.log('[coach_daily] result', result);
  };
}
