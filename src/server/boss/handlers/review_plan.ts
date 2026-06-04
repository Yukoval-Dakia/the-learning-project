// YUK-203 U4 / D5 — review_plan pg-boss handler.
//
// Chain-triggered by coach_daily (NOT a cron — D5:29 "不要另开独立 cron"). Runs
// the tactical ReviewPlanTask over the narrow `review_plan` DomainTool surface
// (4 tools, NO memory — D7) and writes a traceability scan event
// (experimental:review_plan). The task reads the Coach brief itself via
// read_coach_brief; this handler just wires the surface + records the run.
//
// Mirrors dreaming_nightly.ts / coach_daily.ts: builds the MCP bridge with
// resolveDomainToolNames('review_plan') + resolveMcpAllowedTools('review_plan').

import { createId } from '@paralleldrive/cuid2';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';

export type ReviewPlanMode = 'initial_plan' | 'checkpoint_adapt';

export interface ReviewPlanJobData {
  run_kind?: 'daily' | 'on_demand';
  mode?: ReviewPlanMode;
}

export interface ReviewPlanRunResult {
  processed: number;
  task_run_id?: string;
  tool_context_task_run_id: string;
}

type RunAgentTaskFn = (
  kind: string,
  input: unknown,
  ctx: {
    db: Db;
    mcpServers?: Record<string, SdkMcpServer>;
    allowedTools?: string[];
  },
) => Promise<RunTaskResult>;
type BuildMcpServerFn = typeof buildMcpServerFromRegistry;
type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;

export interface ReviewPlanRunDeps {
  runAgentTaskFn?: RunAgentTaskFn;
  buildMcpServerFn?: BuildMcpServerFn;
  writeEventFn?: WriteEventFn;
  now?: () => Date;
}

export const REVIEW_PLAN_OBJECTIVE =
  'Generate a tactical review_plan. First read_coach_brief to get the strategic attention prior (degrade to pure due-pressure when reason is no_plan / empty_brief). Then get_review_knowledge_snapshot + select_review_question_candidates to build an explainable candidate pool, and finally write_review_plan with the subject_ids invariant, guardrail_checks, and needs[]. You read NO memory; the Coach brief is your only attention prior.';

export async function runReviewPlan(
  db: Db,
  data: ReviewPlanJobData,
  deps: ReviewPlanRunDeps = {},
): Promise<ReviewPlanRunResult> {
  const now = deps.now?.() ?? new Date();
  const run = deps.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = deps.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const write = deps.writeEventFn ?? writeEvent;

  const runKind = data.run_kind ?? 'daily';
  const mode: ReviewPlanMode = data.mode ?? 'initial_plan';
  const triggerEventId = `review_plan_trigger_${createId()}`;
  const toolContextTaskRunId = `review_plan_tool_${createId()}`;

  await write(db, {
    id: triggerEventId,
    actor_kind: 'cron',
    actor_ref: 'review_plan',
    action: 'experimental:trigger_review_plan',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: null,
    payload: { surface: 'review_plan', run_kind: runKind, mode },
    created_at: now,
  });

  try {
    const toolNames = resolveDomainToolNames('review_plan');
    const mcpServer = buildMcpServer({
      ctx: {
        db,
        taskRunId: toolContextTaskRunId,
        callerActor: { kind: 'agent', ref: 'review_plan' },
        causedByEventId: triggerEventId,
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames,
      taskKind: 'ReviewPlanTask',
    });

    const taskResult = await run(
      'ReviewPlanTask',
      {
        run_kind: runKind,
        mode,
        now: now.toISOString(),
        objective: REVIEW_PLAN_OBJECTIVE,
      },
      {
        db,
        mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
        allowedTools: [...resolveMcpAllowedTools('review_plan')],
      },
    );

    await write(db, {
      id: `review_plan_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: 'review_plan',
      action: 'experimental:review_plan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        run_kind: runKind,
        mode,
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: triggerEventId,
      task_run_id: taskResult.task_run_id,
      cost_micro_usd:
        taskResult.cost_usd === undefined ? null : Math.round(taskResult.cost_usd * 1_000_000),
      created_at: deps.now?.() ?? new Date(),
    });

    return {
      processed: 1,
      task_run_id: taskResult.task_run_id,
      tool_context_task_run_id: toolContextTaskRunId,
    };
  } catch (err) {
    await write(db, {
      id: `review_plan_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: 'review_plan',
      action: 'experimental:review_plan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'failure',
      payload: {
        run_kind: runKind,
        mode,
        error: err instanceof Error ? err.message : String(err),
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: triggerEventId,
      created_at: deps.now?.() ?? new Date(),
    });
    throw err;
  }
}

export function buildReviewPlanHandler(
  db: Db,
  deps: ReviewPlanRunDeps = {},
): (jobs: Job<ReviewPlanJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const result = await runReviewPlan(db, job.data ?? {}, deps);
      console.log('[review_plan] result', result);
    }
  };
}
