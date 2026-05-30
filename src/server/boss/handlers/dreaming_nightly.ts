import { createId } from '@paralleldrive/cuid2';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
// P5.1 / YUK-143 — single tunable source for the Dreaming run caps. The values
// below are byte-identical to the numbers previously hardcoded here
// (max_proposals 5 / max_tool_calls 8); this is a pure constant relocation, so
// Dreaming behavior is unchanged (spec §3.3).
import { DREAMING_CONTEXT_BUDGET } from '@/server/ai/tools/budgets';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { enqueueDreamingNoteRefine } from '@/server/artifacts/note-refine-triggers';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
// YUK-143 / ADR-0025 — North-Star: feed active goals into the Dreaming input so
// it can BIAS proposals toward weak/under-covered knowledge in their scope.
// Purely ADDITIVE (ND-5): Dreaming still only PROPOSES via the inbox and never
// reads the FSRS-due queue or mutates review state; goals only add direction.
import { type ActiveGoal, listActiveGoals } from '@/server/goals/queries';
import { type ProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';
// T-AR (YUK-TAR) — feed the acceptance-rate SIGNAL into the Dreaming input so it
// can BIAS toward proposal kinds the user historically accepts (and away from
// ones routinely dismissed). Purely ADDITIVE (ND-5), mirrors the YUK-143 goal
// feed: read-only, never reads the FSRS-due queue or mutates review state, and
// degrades to a no-op on cold start (empty signal → unchanged behavior).
import {
  type ProposalKindAcceptanceRate,
  getProposalAcceptanceRates,
} from '@/server/proposals/signals';

// P5.1 / YUK-143 — re-exported alias kept so existing imports / tests don't
// break (spec §4.2). Sourced from DREAMING_CONTEXT_BUDGET.maxProposals (= 5),
// byte-unchanged.
export const DREAMING_MAX_PROPOSALS = DREAMING_CONTEXT_BUDGET.maxProposals as number;

// T-AR (YUK-TAR) — cap how many proposal kinds we surface to the model so the
// input stays bounded. There are 14 proposal kinds total (see proposal.ts); 8
// "top by acceptance" comfortably covers the proven set without flooding.
export const DREAMING_ACCEPTANCE_RATE_TOP_N = 8;

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
// T-AR (YUK-TAR) — swappable acceptance-rate reader (DB tests inject fixtures),
// mirrors ListActiveGoalsFn.
type LoadProposalAcceptanceRatesFn = (db: Db) => Promise<ProposalKindAcceptanceRate[]>;

interface DepsOverride {
  runAgentTaskFn?: RunAgentTaskFn;
  listProposalInboxRowsFn?: ListProposalInboxRowsFn;
  buildMcpServerFn?: BuildMcpServerFn;
  writeEventFn?: WriteEventFn;
  // YUK-143 / ADR-0025 — defaults to listActiveGoals; goals bias proposals
  // toward weak scope only and never touch the review backbone (ND-5).
  listActiveGoalsFn?: ListActiveGoalsFn;
  // T-AR (YUK-TAR) — defaults to getProposalAcceptanceRates; biases toward
  // historically-accepted proposal kinds only, never touches the review
  // backbone, and is a no-op on cold start (ND-5 additive).
  loadProposalAcceptanceRatesFn?: LoadProposalAcceptanceRatesFn;
  now?: () => Date;
}

// YUK-143 / ADR-0025 — North-Star goal-bias guidance appended to the Dreaming
// objective. ND-5 is stated explicitly: the goal bias is ADDITIVE only — it must
// NOT suppress or replace the existing signal-driven proposals, and Dreaming
// still never reads the FSRS-due queue or mutates review state. When
// active_goals is empty the objective is effectively unchanged (back-compat).
const DREAMING_GOAL_BIAS_GUIDANCE =
  ' When active_goals are present, BIAS proposals toward filling weak/under-covered knowledge in their scope_knowledge_ids — additive only; never suppress or replace the existing signal-driven proposals (ND-5). When active_goals is empty, behave exactly as before.';
// T-AR (YUK-TAR) — acceptance-rate bias hint, parallel to the goal-bias string.
// ND-5 additive only: prefer kinds with higher historical acceptance, avoid ones
// routinely dismissed — but never suppress the existing signal-driven proposals.
// When proposal_acceptance_rates is empty (cold start) there is nothing to bias
// on, so the model behaves exactly as before (no-op degrade).
const DREAMING_ACCEPTANCE_RATE_BIAS_GUIDANCE =
  ' When proposal_acceptance_rates are present, prefer proposal kinds with higher historical acceptance and avoid kinds the user routinely dismisses — additive only; never suppress or replace the existing signal-driven proposals (ND-5). When proposal_acceptance_rates is empty, behave exactly as before.';
export const DREAMING_OBJECTIVE = `Review recent learning signals with the provided DomainTools and create only actionable inbox proposals. Do not mutate user data directly.${DREAMING_GOAL_BIAS_GUIDANCE}${DREAMING_ACCEPTANCE_RATE_BIAS_GUIDANCE}`;

function buildDreamingInput(
  now: Date,
  beforeRows: ProposalSnapshotRow[],
  activeGoals: ActiveGoal[],
  acceptanceRates: ProposalKindAcceptanceRate[],
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
    // T-AR (YUK-TAR) — per-kind acceptance-rate signal for the additive bias
    // (ND-5). Already sorted by acceptance_rate DESC, total DESC; capped to the
    // top N proven kinds. Empty array on cold start → no-op (model has nothing
    // to bias on, behaves exactly as before).
    proposal_acceptance_rates: acceptanceRates
      .slice(0, DREAMING_ACCEPTANCE_RATE_TOP_N)
      .map((r) => ({
        kind: r.kind,
        acceptance_rate: r.acceptance_rate,
        accept_count: r.accept_count,
        dismiss_count: r.dismiss_count,
      })),
    budget: {
      // P5.1 / YUK-143 — sourced from DREAMING_CONTEXT_BUDGET (8 / 5),
      // byte-identical to the prior hardcoded literals.
      max_tool_calls: DREAMING_CONTEXT_BUDGET.maxToolCalls,
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
  const loadAcceptanceRates = deps.loadProposalAcceptanceRatesFn ?? getProposalAcceptanceRates;

  const beforeRows = await listRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  // YUK-143 / ADR-0025 — read active goals for the additive goal bias. This is a
  // read-only ADD to the Dreaming signal set; it does not read the FSRS-due
  // queue or mutate any review state (ND-5).
  const activeGoals = await listGoals(db);
  // T-AR (YUK-TAR) — read the acceptance-rate signal for the additive bias.
  // Read-only ADD; no FSRS-due read, no review-state mutation (ND-5). Empty on
  // cold start → the input feed degrades to a no-op.
  const acceptanceRates = await loadAcceptanceRates(db);
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

    const taskResult = await run(
      'DreamingTask',
      buildDreamingInput(now, beforeRows, activeGoals, acceptanceRates),
      {
        db,
        mcpServers: { [DOMAIN_TOOL_MCP_SERVER_NAME]: mcpServer },
        allowedTools: [...resolveMcpAllowedTools('dreaming')],
      },
    );

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
