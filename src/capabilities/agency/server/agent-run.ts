// The agency nightly domain-agent scan operation.
//
// Single owner of the complete run assembly: inbox before-read → `experimental:trigger_<surface>_scan`
// event → ContextBudgetTracker + propose-cap beforeExecute gate + interceptInput throttle on a
// piDomainMount → runAgentTask with the `hard+1` summary-turn budgetOverride → inbox after-diff →
// per-new-row hook → `experimental:<surface>_scan` success/failure events → rethrow. Surface
// differences stay in the spec: actor_ref, payload slots, TodayPlan extras, note-refine fan-out.

import { type BuildMcpServerOptions, piDomainMount } from '@/ai/pi-tool-mount';
import type { ToolExecutionGateInput } from '@/kernel/tools/types';
import { createId } from '@paralleldrive/cuid2';
import type { RunTaskResult } from '@/ai/task-result';
import type { Db } from '@/db/client';
import { type WriteEventInput, writeEvent } from '@/kernel/events';
import { type ProposalInboxRow, listProposalInboxRows } from '@/kernel/proposals/inbox';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  type DomainToolSurface,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/kernel/tools/allowlists';
import type { ContextBudget } from '@/kernel/tools/budgets';
import { ContextBudgetTracker } from '@/kernel/tools/context-throttle';
import { type RunAgentTaskCtx, runAgentTask } from '@/server/ai/runner';

/**
 * The inbox row slice the scan diff needs. Only Dreaming's note-refine fan-out reads
 * `kind`/`target`, so both stay optional and each consumer narrows in its own code.
 */
export type AgencyScanInboxRow = Pick<ProposalInboxRow, 'id' | 'status'> &
  Partial<Pick<ProposalInboxRow, 'kind' | 'target'>>;

/**
 * The result slice the scan bookkeeping needs. `task_run_id` is always present;
 * `cost_usd`/`text` stay optional because injected runners may omit them.
 */
export type AgencyScanRunResult = Pick<RunTaskResult, 'task_run_id' | 'cost_usd'> &
  Partial<Pick<RunTaskResult, 'text'>>;

export type AgencyScanRunCtx = Pick<
  RunAgentTaskCtx,
  'db' | 'budgetOverride' | 'piToolMounts' | 'allowedTools'
>;

export type AgencyScanRunFn = (
  kind: string,
  input: unknown,
  ctx: AgencyScanRunCtx,
) => Promise<AgencyScanRunResult>;

export interface AgencyProposalScanDeps {
  /** Clock seam: called once for the run anchor, again per scan-event write. */
  now?: () => Date;
  writeEventFn?: (db: Db, input: WriteEventInput) => Promise<string>;
  listProposalInboxRowsFn?: (db: Db) => Promise<AgencyScanInboxRow[]>;
  /** Runner seam. */
  runAgentTaskFn?: AgencyScanRunFn;
}

export interface AgencyProposalScanSpec {
  /**
   * DomainTool surface — resolves the mount toolNames + MCP allowedTools, names the agent
   * actor_ref, the trigger/scan actions and event ids, and the proposal-cap label.
   */
  surface: DomainToolSurface;
  /**
   * Registered task kind, also stamped as tool_call_log task_kind. A literal union so the
   * task census resolves production callers; extend it when another scan surface joins.
   */
  taskKind: 'DreamingTask' | 'CoachTask';
  /** actor_ref on the cron trigger event (e.g. 'nightly_dreaming'). */
  triggerActorRef: string;
  /** Per-run context budget: tracker bounds + the hard+1 summary turn. */
  budget: ContextBudget;
  deps?: AgencyProposalScanDeps;
  /**
   * Read signals after the inbox snapshot, before the trigger event. Return the input
   * builder so assembly still happens inside the scan failure boundary at the runner call.
   */
  prepareInput: (ctx: {
    db: Db;
    now: Date;
    beforeRows: AgencyScanInboxRow[];
  }) => Promise<() => unknown>;
  /** Extra trigger payload fields (Coach stamps `run_kind`). */
  extraTriggerPayload?: Record<string, unknown>;
  /**
   * Scan-success payload extras computed from the task result and the built runner input —
   * the SAME object passed to runAgentTask, so facts computed in prepareInput reach the
   * payload without a second read.
   */
  buildScanSuccessPayloadExtras?: (
    taskResult: AgencyScanRunResult,
    input: unknown,
  ) => Record<string, unknown>;
  /** Extra scan-failure payload fields (Coach stamps `run_kind`). */
  extraScanFailurePayload?: Record<string, unknown>;
  /**
   * Runs between the after-diff and the scan-success write — Dreaming's note_update →
   * note-refine enqueue fan-out. Receives only the NEW rows.
   */
  onNewProposalRows?: (args: {
    db: Db;
    newRows: AgencyScanInboxRow[];
    triggerEventId: string;
  }) => Promise<void>;
}

export interface AgencyProposalScanResult {
  processed: number;
  proposals_created: number;
  pending_after: number;
  task_run_id?: string;
  tool_context_task_run_id: string;
}

export async function runAgencyProposalScan(
  db: Db,
  spec: AgencyProposalScanSpec,
): Promise<AgencyProposalScanResult> {
  const deps = spec.deps ?? {};
  // Hoisted so the task census resolves both served kinds at this callsite.
  const { taskKind } = spec;
  const now = deps.now?.() ?? new Date();
  const listRows = deps.listProposalInboxRowsFn ?? listProposalInboxRows;
  const write = deps.writeEventFn ?? writeEvent;
  const run: AgencyScanRunFn = deps.runAgentTaskFn ?? runAgentTask;
  const maxProposals = spec.budget.maxProposals ?? Number.POSITIVE_INFINITY;

  const beforeRows = await listRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  const buildInput = await spec.prepareInput({ db, now, beforeRows });
  const triggerEventId = `${spec.surface}_trigger_${createId()}`;
  const toolContextTaskRunId = `${spec.surface}_tool_${createId()}`;

  await write(db, {
    id: triggerEventId,
    actor_kind: 'cron',
    actor_ref: spec.triggerActorRef,
    action: `experimental:trigger_${spec.surface}_scan`,
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: null,
    payload: {
      surface: spec.surface,
      ...spec.extraTriggerPayload,
      pending_before: beforeRows.filter((row) => row.status === 'pending').length,
    },
    created_at: now,
  });

  try {
    let proposalWrites = 0;
    const budgetTracker = new ContextBudgetTracker(spec.budget);
    // piDomainMount compiles the DomainTools into AgentTools with the same
    // beforeExecute/interceptInput gates via executeDomainToolCall.
    const domainMountOptions = {
      ctx: {
        db,
        taskRunId: toolContextTaskRunId,
        providerAttemptCaller: 'worker',
        providerSessionDeadlineAt: Date.now() + 65_000,
        callerActor: { kind: 'agent', ref: spec.surface },
        causedByEventId: triggerEventId,
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames: resolveDomainToolNames(spec.surface),
      taskKind,
      beforeExecute: (tool: ToolExecutionGateInput) => {
        const budgetReason = budgetTracker.beforeExecute(tool);
        if (budgetReason) return budgetReason;
        if (tool.effect !== 'propose') return undefined;
        if (proposalWrites >= maxProposals) {
          return `${spec.surface} proposal cap reached (${maxProposals}); stop creating proposals in this run`;
        }
        proposalWrites += 1;
        return undefined;
      },
      interceptInput: (tool: ToolExecutionGateInput, args: unknown) => {
        const { args: capped, contextBudget, softStop } = budgetTracker.capInput(tool.name, args);
        return { args: capped, truncationNote: contextBudget, softStop };
      },
    } satisfies BuildMcpServerOptions;
    const input = buildInput();
    const taskResult = await run(taskKind, input, {
      db,
      // maxTurns must not pre-empt the runtime tool-call ceiling: keep one final turn
      // for the agent's summary after the last allowed tool call.
      budgetOverride: { maxIterations: spec.budget.toolCalls.hard + 1 },
      piToolMounts: [piDomainMount(domainMountOptions)],
      allowedTools: [...resolveMcpAllowedTools(spec.surface)],
    });

    const afterRows = await listRows(db);
    const pendingAfter = afterRows.filter((row) => row.status === 'pending').length;
    const newRows = afterRows.filter((row) => !beforeIds.has(row.id));
    const proposalsCreated = newRows.length;
    await spec.onNewProposalRows?.({ db, newRows, triggerEventId });

    await write(db, {
      id: `${spec.surface}_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: spec.surface,
      action: `experimental:${spec.surface}_scan`,
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        proposals_created: proposalsCreated,
        pending_after: pendingAfter,
        tool_context_task_run_id: toolContextTaskRunId,
        ...spec.buildScanSuccessPayloadExtras?.(taskResult, input),
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
      id: `${spec.surface}_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: spec.surface,
      action: `experimental:${spec.surface}_scan`,
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'failure',
      payload: {
        ...spec.extraScanFailurePayload,
        error: err instanceof Error ? err.message : String(err),
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: triggerEventId,
      created_at: deps.now?.() ?? new Date(),
    });
    throw err;
  }
}
