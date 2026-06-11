import { createId } from '@paralleldrive/cuid2';
import type { Job } from 'pg-boss';

import { type AgentNote, readAgentNotes } from '@/capabilities/agent-notes/server/notes';
import { enqueueDreamingNoteRefine } from '@/capabilities/notes/server/note-refine-triggers';
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
// P5.4-L2 / YUK-174 (Facet A, §3.2) — PROPOSAL_FEEDBACK_BUDGET bounds the new
// per-(kind, relation) digest (see the getProposalFeedbackDigest import below).
import { DREAMING_CONTEXT_BUDGET, PROPOSAL_FEEDBACK_BUDGET } from '@/server/ai/tools/budgets';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
// YUK-143 / ADR-0025 — North-Star: feed active goals into the Dreaming input so
// it can BIAS proposals toward weak/under-covered knowledge in their scope.
// Purely ADDITIVE (ND-5): Dreaming still only PROPOSES via the inbox and never
// reads the FSRS-due queue or mutates review state; goals only add direction.
import { type ActiveGoal, listActiveGoals } from '@/server/goals/queries';
import {
  type ProposalFeedbackCell,
  getProposalFeedbackDigest,
} from '@/server/proposals/adaptive-bias';
import { type ProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';

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
// mirrors ListActiveGoalsFn. P5.4-L2 / YUK-174 (Facet A) — now returns the
// per-(kind, relation) feedback digest (a strict superset of the prior per-kind
// rate). The seam NAME is unchanged so existing injection sites keep working.
type LoadProposalAcceptanceRatesFn = (db: Db) => Promise<ProposalFeedbackCell[]>;
// U8 / AF §4 — swappable un-expired agent-note reader (DB tests inject
// fixtures). Notes are HINTS, not facts — additive context only; an empty list
// (the common case) leaves the Dreaming input unchanged.
type ReadAgentNotesFn = (db: Db, now: Date) => Promise<AgentNote[]>;

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
  // U8 / AF §4 — defaults to readAgentNotes(for_agent='dreaming'); reads the
  // out-of-band hint channel. Additive only: hints bias attention, never the
  // FSRS-due queue or review state (ND-5).
  readAgentNotesFn?: ReadAgentNotesFn;
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
// P5.4-L2 / YUK-174 (Facet A, §3.2) — reason-feedback hint for the per-(kind,
// relation) digest. For each cell, top_dismiss_reasons (the user's own words for
// why they dismissed) and top_rubric_gates (the machine reason the rubric
// rejected) tell you the SPECIFIC failure mode — avoid repeating it. Scoped to
// the kinds Dreaming can act on; additive only, never suppress signal-driven
// proposals (ND-5); empty proposal_feedback (cold start) = behave exactly as
// before.
const DREAMING_PROPOSAL_FEEDBACK_GUIDANCE =
  ' When proposal_feedback is present, each entry is a (kind, relation) cell with top_dismiss_reasons (why the user dismissed) and top_rubric_gates (why the rubric rejected) — read them as the specific failure mode for that cell and avoid repeating it; additive only, never suppress or replace the existing signal-driven proposals (ND-5). When proposal_feedback is empty, behave exactly as before.';
// U8 / AF §4 — agent_notes are out-of-band HINTS left by narrow tasks (provenance
// + expiry), NOT facts. Weigh them as soft attention priors; never treat a note
// as ground truth and never let it suppress the signal-driven proposals (ND-5).
// Empty agent_notes (the common case) = behave exactly as before.
const DREAMING_AGENT_NOTES_GUIDANCE =
  ' When agent_notes are present, treat each as a soft HINT (not a fact) left by a narrow task — it has a signal_kind, refs, and confidence; use it to direct attention, never as ground truth, and never let it suppress or replace the signal-driven proposals (ND-5). When agent_notes is empty, behave exactly as before.';
export const DREAMING_OBJECTIVE = `Review recent learning signals with the provided DomainTools and create only actionable inbox proposals. Do not mutate user data directly.${DREAMING_GOAL_BIAS_GUIDANCE}${DREAMING_ACCEPTANCE_RATE_BIAS_GUIDANCE}${DREAMING_PROPOSAL_FEEDBACK_GUIDANCE}${DREAMING_AGENT_NOTES_GUIDANCE}`;

// P5.4-L2 / YUK-174 (Facet A, §3.2) — the proposal kinds Dreaming can ACT on,
// scoped to its ACTUAL tool surface (DREAMING_TOOLS, allowlists.ts). The all-kind
// RATE is still surfaced for every kind (background bias); only the new REASON
// fields are scoped here so prompt budget is not spent on a kind Dreaming cannot
// act on.
//
// SPEC NOTE (resolved contradiction): the L2 spec §1.2/§3.2 asserts "Dreaming
// does NOT propose knowledge_edge (DREAMING_TOOLS)". The MERGED code disagrees —
// DREAMING_TOOLS spreads KNOWLEDGE_REVIEW_TOOLS, which DOES grant
// propose_knowledge_edge + propose_knowledge_mutation. Code is authoritative
// (project rule), and the spec's PRINCIPLE is "feed each surface the kinds it can
// act on". So Dreaming's actable set includes knowledge_edge (relation +
// top_rubric_gates) and knowledge_node / archive (the knowledge-mutation kinds),
// alongside its learning-item / record kinds — matching the real surface, not the
// spec's stale claim. (record_links / record_promotion are the record-tool kinds.)
const DREAMING_ACTABLE_KINDS = new Set([
  'completion',
  'relearn',
  'record_links',
  'record_promotion',
  'knowledge_edge',
  'knowledge_node',
  'archive',
]);

// P5.4-L2 / YUK-174 (Facet A, §3.2) — roll the per-(kind, relation) digest back
// UP to the per-kind acceptance RATE the existing feed surfaces (edge cells now
// split by relation, so they must be re-summed). This keeps the all-kind rate a
// strict SUPERSET-compatible subset of the old behavior. Sorted by rate DESC,
// then total (accept+dismiss) DESC — matching getProposalAcceptanceRates — then
// kind ASC as a final deterministic tiebreak so rate-ties don't keep
// small-sample kinds nondeterministically (CodeRabbit C3).
function rollUpToPerKindRate(
  digest: ProposalFeedbackCell[],
): Array<{ kind: string; acceptance_rate: number; accept_count: number; dismiss_count: number }> {
  const byKind = new Map<string, { accept_count: number; dismiss_count: number }>();
  for (const cell of digest) {
    const agg = byKind.get(cell.kind) ?? { accept_count: 0, dismiss_count: 0 };
    agg.accept_count += cell.accept_count;
    agg.dismiss_count += cell.dismiss_count;
    byKind.set(cell.kind, agg);
  }
  return [...byKind.entries()]
    .map(([kind, agg]) => {
      const total = agg.accept_count + agg.dismiss_count;
      return {
        kind,
        accept_count: agg.accept_count,
        dismiss_count: agg.dismiss_count,
        acceptance_rate: total === 0 ? 0 : agg.accept_count / total,
      };
    })
    .sort(
      (a, b) =>
        b.acceptance_rate - a.acceptance_rate ||
        b.accept_count + b.dismiss_count - (a.accept_count + a.dismiss_count) ||
        a.kind.localeCompare(b.kind),
    ); // rate DESC, then total (accept+dismiss) DESC, then kind ASC for determinism
}

function buildDreamingInput(
  now: Date,
  beforeRows: ProposalSnapshotRow[],
  activeGoals: ActiveGoal[],
  feedbackDigest: ProposalFeedbackCell[],
  agentNotes: AgentNote[],
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
    // (ND-5). Rolled up from the per-(kind, relation) digest (strict subset of
    // the prior behavior); sorted by acceptance_rate DESC; capped to the top N
    // proven kinds. Empty array on cold start → no-op (model has nothing to bias
    // on, behaves exactly as before).
    proposal_acceptance_rates: rollUpToPerKindRate(feedbackDigest).slice(
      0,
      DREAMING_ACCEPTANCE_RATE_TOP_N,
    ),
    // P5.4-L2 / YUK-174 (Facet A, §3.2) — per-(kind, relation) reason feedback,
    // scoped to the kinds Dreaming can ACT on (DREAMING_ACTABLE_KINDS). The
    // all-kind RATE above stays the background bias for every kind; the REASON
    // fields (top_dismiss_reasons / top_rubric_gates) are only fed for actable
    // kinds. knowledge_edge IS actable here — DREAMING_TOOLS spreads
    // KNOWLEDGE_REVIEW_TOOLS (allowlists.ts), which grants propose_knowledge_edge,
    // so the edge cell (relation + top_rubric_gates) reaches Dreaming; only kinds
    // outside DREAMING_ACTABLE_KINDS are dropped so no prompt budget is spent on a
    // kind Dreaming cannot propose (spec §3.2). Bounded by
    // PROPOSAL_FEEDBACK_BUDGET.maxKindRelations (the digest is already sorted +
    // capped). Empty on cold start → no-op.
    proposal_feedback: feedbackDigest
      .filter((cell) => DREAMING_ACTABLE_KINDS.has(cell.kind))
      .map((cell) => ({
        kind: cell.kind,
        relation: cell.relation,
        acceptance_rate: cell.acceptance_rate,
        accept_count: cell.accept_count,
        dismiss_count: cell.dismiss_count,
        top_dismiss_reasons: cell.top_dismiss_reasons,
        top_rubric_gates: cell.top_rubric_gates,
      })),
    // U8 / AF §4 — un-expired out-of-band hints addressed to 'dreaming'. HINTS,
    // not facts (the objective guidance above says so explicitly). Empty array
    // when no fresh notes exist → model behaves exactly as before.
    agent_notes: agentNotes.map((n) => ({
      id: n.id,
      signal_kind: n.signal_kind,
      summary_md: n.summary_md,
      refs: n.refs,
      source_task_kind: n.source_task_kind,
      ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
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
  const loadAcceptanceRates =
    deps.loadProposalAcceptanceRatesFn ??
    ((db: Db) => getProposalFeedbackDigest(db, PROPOSAL_FEEDBACK_BUDGET));
  // U8 / AF §4 — default to the un-expired note reader for 'dreaming'. Read-only
  // ADD to the Dreaming signal set; never reads the FSRS-due queue or mutates
  // review state (ND-5).
  const readNotes =
    deps.readAgentNotesFn ??
    ((db: Db, now: Date) => readAgentNotes(db, { for_agent: 'dreaming', now }));

  const beforeRows = await listRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  // YUK-143 / ADR-0025 — read active goals for the additive goal bias. This is a
  // read-only ADD to the Dreaming signal set; it does not read the FSRS-due
  // queue or mutate any review state (ND-5).
  const activeGoals = await listGoals(db);
  // T-AR (YUK-TAR) — read the acceptance-rate signal for the additive bias.
  // Read-only ADD; no FSRS-due read, no review-state mutation (ND-5). Empty on
  // cold start → the input feed degrades to a no-op.
  const feedbackDigest = await loadAcceptanceRates(db);
  // U8 / AF §4 — read un-expired hints addressed to Dreaming. Empty on the
  // common cold path → input feed degrades to a no-op.
  const agentNotes = await readNotes(db, now);
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
      buildDreamingInput(now, beforeRows, activeGoals, feedbackDigest, agentNotes),
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
