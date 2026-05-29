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
import { enqueueDreamingNoteRefine } from '@/server/artifacts/note-refine-triggers';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
// YUK-143 / ADR-0025 — North-Star: feed active goals into the Dreaming input so
// it can BIAS proposals toward weak/under-covered knowledge in their scope.
// Purely ADDITIVE (ND-5): Dreaming still only PROPOSES via the inbox and never
// reads the FSRS-due queue or mutates review state; goals only add direction.
import { type ActiveGoal, listActiveGoals } from '@/server/goals/queries';
import { type ProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';

export const DREAMING_MAX_PROPOSALS = 5;

export interface DreamingNightlyResult {
  processed: number;
  proposals_created: number;
  pending_after: number;
  task_run_id?: string;
  tool_context_task_run_id: string;
}

type ProposalSnapshotRow = Pick<ProposalInboxRow, 'id' | 'status'> &
  Partial<Pick<ProposalInboxRow, 'kind' | 'target'>>;
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

interface DepsOverride {
  runAgentTaskFn?: RunAgentTaskFn;
  listProposalInboxRowsFn?: ListProposalInboxRowsFn;
  buildMcpServerFn?: BuildMcpServerFn;
  writeEventFn?: WriteEventFn;
  // YUK-143 / ADR-0025 — defaults to listActiveGoals; goals bias proposals
  // toward weak scope only and never touch the review backbone (ND-5).
  listActiveGoalsFn?: ListActiveGoalsFn;
  now?: () => Date;
}

// YUK-143 / ADR-0025 — North-Star goal-bias guidance appended to the Dreaming
// objective. ND-5 is stated explicitly: the goal bias is ADDITIVE only — it must
// NOT suppress or replace the existing signal-driven proposals, and Dreaming
// still never reads the FSRS-due queue or mutates review state. When
// active_goals is empty the objective is effectively unchanged (back-compat).
const DREAMING_GOAL_BIAS_GUIDANCE =
  ' When active_goals are present, BIAS proposals toward filling weak/under-covered knowledge in their scope_knowledge_ids — additive only; never suppress or replace the existing signal-driven proposals (ND-5). When active_goals is empty, behave exactly as before.';
export const DREAMING_OBJECTIVE = `Review recent learning signals with the provided DomainTools and create only actionable inbox proposals. Do not mutate user data directly.${DREAMING_GOAL_BIAS_GUIDANCE}`;

function buildDreamingInput(
  now: Date,
  beforeRows: ProposalSnapshotRow[],
  activeGoals: ActiveGoal[],
) {
  return {
    run_kind: 'nightly',
    now: now.toISOString(),
    pending_proposals_before: beforeRows.filter((row) => row.status === 'pending').length,
    objective: DREAMING_OBJECTIVE,
    // YUK-143 / ADR-0025 — active goals for the additive goal bias (ND-5).
    // Ordered by sequence_hint then created_at (listActiveGoals). Empty array
    // when no goals exist → model behaves as before, proposals unchanged.
    active_goals: activeGoals.map((g) => ({
      id: g.id,
      title: g.title,
      subject_id: g.subject_id,
      scope_knowledge_ids: g.scope_knowledge_ids,
      sequence_hint: g.sequence_hint,
    })),
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
  const listGoals = deps.listActiveGoalsFn ?? listActiveGoals;

  const beforeRows = await listRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  // YUK-143 / ADR-0025 — read active goals for the additive goal bias. This is a
  // read-only ADD to the Dreaming signal set; it does not read the FSRS-due
  // queue or mutate any review state (ND-5).
  const activeGoals = await listGoals(db);
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

    const taskResult = await run('DreamingTask', buildDreamingInput(now, beforeRows, activeGoals), {
      db,
      mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
      allowedTools: [...resolveMcpAllowedTools('dreaming')],
    });

    const afterRows = await listRows(db);
    const pendingAfter = afterRows.filter((row) => row.status === 'pending').length;
    const proposalsCreated = afterRows.filter((row) => !beforeIds.has(row.id)).length;
    const newDreamingNoteTargets = [
      ...new Set(
        afterRows
          .filter((row) => !beforeIds.has(row.id))
          .filter(
            (row) =>
              row.kind === 'note_update' &&
              row.target?.subject_kind === 'artifact' &&
              typeof row.target.subject_id === 'string',
          )
          .map((row) => row.target?.subject_id)
          .filter((artifactId): artifactId is string => Boolean(artifactId)),
      ),
    ];
    await Promise.all(
      newDreamingNoteTargets.map((artifactId) =>
        enqueueDreamingNoteRefine({ db, artifactId, triggerEventId }),
      ),
    );

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
