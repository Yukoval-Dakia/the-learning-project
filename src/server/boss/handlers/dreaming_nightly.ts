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
import { type ProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';

export const DREAMING_MAX_PROPOSALS = 5;

export interface DreamingNightlyResult {
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

interface DepsOverride {
  runAgentTaskFn?: RunAgentTaskFn;
  listProposalInboxRowsFn?: ListProposalInboxRowsFn;
  buildMcpServerFn?: BuildMcpServerFn;
  writeEventFn?: WriteEventFn;
  now?: () => Date;
}

function buildDreamingInput(now: Date, beforeRows: ProposalSnapshotRow[]) {
  return {
    run_kind: 'nightly',
    now: now.toISOString(),
    pending_proposals_before: beforeRows.filter((row) => row.status === 'pending').length,
    objective:
      'Review recent learning signals with the provided DomainTools and create only actionable inbox proposals. Do not mutate user data directly.',
    budget: {
      max_tool_calls: 8,
      max_proposals: DREAMING_MAX_PROPOSALS,
      stop_when_no_actionable_proposal: true,
    },
    proposal_policy: {
      prefer_existing_proposal_tools: true,
      avoid_duplicates: true,
      no_silent_writes: true,
    },
  };
}

export async function runDreamingNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<DreamingNightlyResult> {
  const now = deps.now?.() ?? new Date();
  const listRows = deps.listProposalInboxRowsFn ?? listProposalInboxRows;
  const run = deps.runAgentTaskFn ?? runAgentTask;
  const buildMcpServer = deps.buildMcpServerFn ?? buildMcpServerFromRegistry;
  const write = deps.writeEventFn ?? writeEvent;

  const beforeRows = await listRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  const triggerEventId = `dreaming_trigger_${createId()}`;
  const toolContextTaskRunId = `dreaming_tool_${createId()}`;

  await write(db, {
    id: triggerEventId,
    actor_kind: 'cron',
    actor_ref: 'nightly_dreaming',
    action: 'experimental:trigger_dreaming_scan',
    subject_kind: 'query',
    subject_id: triggerEventId,
    outcome: null,
    payload: {
      surface: 'dreaming',
      pending_before: beforeRows.filter((row) => row.status === 'pending').length,
    },
    created_at: now,
  });

  try {
    const toolNames = resolveDomainToolNames('dreaming');
    let proposalWrites = 0;
    const mcpServer = buildMcpServer({
      ctx: {
        db,
        taskRunId: toolContextTaskRunId,
        callerActor: { kind: 'agent', ref: 'dreaming' },
        causedByEventId: triggerEventId,
      },
      serverName: DOMAIN_TOOL_MCP_SERVER_NAME,
      toolNames,
      taskKind: 'DreamingTask',
      beforeExecute: (tool) => {
        if (tool.effect !== 'propose' && tool.effect !== 'write') return undefined;
        if (proposalWrites >= DREAMING_MAX_PROPOSALS) {
          return `dreaming proposal cap reached (${DREAMING_MAX_PROPOSALS}); stop creating proposals in this run`;
        }
        proposalWrites += 1;
        return undefined;
      },
    });

    const taskResult = await run('DreamingTask', buildDreamingInput(now, beforeRows), {
      db,
      mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
      allowedTools: [...resolveMcpAllowedTools('dreaming')],
    });

    const afterRows = await listRows(db);
    const pendingAfter = afterRows.filter((row) => row.status === 'pending').length;
    const proposalsCreated = afterRows.filter((row) => !beforeIds.has(row.id)).length;

    await write(db, {
      id: `dreaming_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'experimental:dreaming_scan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'success',
      payload: {
        proposals_created: proposalsCreated,
        pending_after: pendingAfter,
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
      proposals_created: proposalsCreated,
      pending_after: pendingAfter,
      task_run_id: taskResult.task_run_id,
      tool_context_task_run_id: toolContextTaskRunId,
    };
  } catch (err) {
    await write(db, {
      id: `dreaming_scan_${createId()}`,
      actor_kind: 'agent',
      actor_ref: 'dreaming',
      action: 'experimental:dreaming_scan',
      subject_kind: 'query',
      subject_id: triggerEventId,
      outcome: 'failure',
      payload: {
        error: err instanceof Error ? err.message : String(err),
        tool_context_task_run_id: toolContextTaskRunId,
      },
      caused_by_event_id: triggerEventId,
      created_at: deps.now?.() ?? new Date(),
    });
    throw err;
  }
}

export function buildDreamingNightlyHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runDreamingNightly(db, deps);
    console.log('[dreaming_nightly] result', result);
  };
}
