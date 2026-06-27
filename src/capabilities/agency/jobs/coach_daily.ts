// Wave 5 / T-D6/B — coach_daily pg-boss handler.
//
// Mirrors sibling ./dreaming_nightly.ts. Builds the COACH
// allowlist MCP bridge, runs `CoachTask`, and writes trigger + scan events
// (`experimental:trigger_coach_scan` / `experimental:coach_scan`).

import { createId } from '@paralleldrive/cuid2';
import type { Job } from 'pg-boss';

// YUK-143 / ADR-0025 — North-Star: feed active goals into the Coach input so it
// can add a goal-oriented strand. Purely ADDITIVE (ND-5): the FSRS-due / review
// backbone and other capture tasks are untouched; goals only add direction.
import { type ActiveGoal, listActiveGoals } from '@/capabilities/agency/server/goals/queries';
// codex #3356884494 — Coach consumes the out-of-band agent-note HINT channel
// (for_agent='coach'). quiz_verify leaves question_pool_gap notes targeting
// 'coach', but nothing read them until now (the only live readers were Dreaming /
// KnowledgeReview). Mirrors dreaming_nightly.ts: hints, not facts; additive only.
import { type AgentNote, readAgentNotes } from '@/capabilities/agency/server/notes';
import { type TodayPlanT, parseTodayPlan } from '@/core/schema/coach';
import type { Db } from '@/db/client';
import { type RunTaskResult, runAgentTask } from '@/server/ai/runner';
import {
  DOMAIN_TOOL_MCP_SERVER_NAME,
  resolveDomainToolNames,
  resolveMcpAllowedTools,
} from '@/server/ai/tools/allowlists';
// P5.1 / YUK-143 — single tunable source for the Coach run caps. The values
// below are byte-identical to the numbers previously hardcoded here
// (max_proposals 5 / max_tool_calls 12); pure constant relocation, so Coach
// behavior is unchanged (spec §3.3).
import { COACH_CONTEXT_BUDGET, PROPOSAL_FEEDBACK_BUDGET } from '@/server/ai/tools/budgets';
import { type SdkMcpServer, buildMcpServerFromRegistry } from '@/server/ai/tools/mcp-bridge';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
// YUK-203 U4 / D11① — feed active/pinned learning items' knowledge_ids into the
// Coach input as ATTENTION PRESSURE only (CO §7.1:723-726). Purely additive
// (ND-5): never carries scheduling/bookkeeping, never touches the FSRS-due
// review backbone. Coach folds it into the brief's knowledge_focus.
import { type ActiveLearningItem, listActiveLearningItems } from '@/server/learning-items/queries';
// P5.4-L2 / YUK-174 (Facet A + C, §3.3) — feed the per-(kind, relation) accept-
// learned reason digest into the Coach input. Scoped to the kinds Coach can act
// on; Coach now proposes knowledge_edge (AB-4), so its scope INCLUDES edge cells
// (relation + top_rubric_gates). Purely additive / cold-start inert (ND-5).
import {
  type ProposalFeedbackCell,
  getProposalFeedbackDigest,
} from '@/server/proposals/adaptive-bias';
import { type ProposalInboxRow, listProposalInboxRows } from '@/server/proposals/inbox';

// P5.1 / YUK-143 — re-exported alias kept so existing imports / tests don't
// break (spec §4.2). Sourced from COACH_CONTEXT_BUDGET.maxProposals (= 5),
// byte-unchanged.
export const COACH_MAX_PROPOSALS = COACH_CONTEXT_BUDGET.maxProposals as number;
// YUK-143 / ADR-0025 — North-Star goal strand guidance appended to the Coach
// objective. ND-5 is stated explicitly: the goal strand is ADDITIVE only — it
// must NOT suppress FSRS-due reviews, hide other capture tasks, preempt the
// daily quota, or change due times. When active_goals is present the model adds
// a `goal_strand` (each item tagged `serves_goal_id` + `knowledge_ids`) and
// lists the addressed goals in `goal_ids`, distributing effort across goals
// (round-robin + weakest-scope first). When empty, omit the strand.
const COACH_GOAL_STRAND_GUIDANCE =
  ' If active_goals are provided, additionally add a goal-oriented strand: set TodayPlan.goal_ids to the goals you address and add goal_strand items (each tagged serves_goal_id + knowledge_ids). Distribute attention across active goals (round-robin + weakest-scope first). CRITICAL: the goal strand is purely additive direction — it must NOT suppress or replace the FSRS-due review backbone, hide other capture tasks, preempt the daily review quota, or change any due times. If there are no active goals, omit the goal strand.';
// P5.4-L2 / YUK-174 (Facet A + C, §3.3) — ND-5 reason-feedback clause PLUS brief
// when-to-propose-an-edge guidance (Coach now holds propose_knowledge_edge, so
// the edge feedback is actionable, not a dead grant). Empty proposal_feedback
// (cold start) makes this clause inert.
const COACH_PROPOSAL_FEEDBACK_GUIDANCE =
  ' When proposal_feedback is present, each entry is a (kind, relation) cell carrying top_dismiss_reasons (why the user dismissed) and, for knowledge_edge cells, top_rubric_gates (why the rubric rejected) — read them as the specific failure mode and avoid repeating it; additive only, never suppress or replace the review backbone or signal-driven proposals (ND-5). Only propose a knowledge_edge when a concrete mistake pattern shows two knowledge points are confused / ordered / applied together AND that relation has not been routinely dismissed; otherwise skip the edge. When proposal_feedback is empty, behave exactly as before.';
// P5.6 / YUK-178 (§4.1, SK-5) — prime the model to set the propose-tool
// suggestion_kind arg per proposal: proactive (the default) for a next-step
// suggestion off a successful read; corrective ONLY when the proposal repairs a
// failure the model itself observed. A zero-result read is a legitimate success
// (outcome:'success' — "I looked and found nothing"), NOT a corrective trigger.
// There is NO deterministic post-process fallback — corrective is purely the
// model's explicit, honest label.
const COACH_SUGGESTION_KIND_GUIDANCE =
  " On each propose_* tool call set the optional suggestion_kind argument: use 'proactive' (the default — omit it) when you are proposing a next step off a successful read; use 'corrective' ONLY when the proposal repairs a specific failure you yourself just observed. A read that returns zero results is a legitimate success (you looked and found nothing), NOT a failure — do NOT label a proposal corrective merely because an upstream read came back empty. Only a genuine repair of an observed failure is corrective.";
// codex #3356884494 / AF §4 — agent_notes are out-of-band HINTS left by narrow
// tasks (provenance + expiry), NOT facts. Weigh them as soft attention priors
// for the day's plan (e.g. a question_pool_gap hint = a knowledge point that may
// still lack a usable question); never treat a note as ground truth and never
// let it suppress the FSRS-due review backbone or signal-driven proposals (ND-5).
// Empty agent_notes (the common case) = behave exactly as before.
const COACH_AGENT_NOTES_GUIDANCE =
  ' When agent_notes are present, treat each as a soft HINT (not a fact) left by a narrow task — it has a signal_kind, refs, and confidence; use it to direct attention when shaping the plan, never as ground truth, and never let it suppress or replace the FSRS-due review backbone or signal-driven proposals (ND-5). When agent_notes is empty, behave exactly as before.';
// YUK-203 U4 / D5 + CO §6.1:679-681 — the review_session_proposal is a strategic
// BRIEF, and it is the attention prior the daily Coach brief carries (historically consumed by the now-retired ReviewPlanTask). Coach
// must populate the brief fields: knowledge_focus (ranked from due/weak signals
// PLUS the active_items attention pressure), subject_mix, time_box_minutes,
// intent_tags. CRITICAL (D11): active_items are attention pressure ONLY — they
// influence what the brief prioritises, never bookkeeping / scheduling state,
// and the brief never suppresses the FSRS-due review backbone (ND-5). When
// active_items is empty, derive the brief from due/weak signals alone.
const COACH_BRIEF_GUIDANCE =
  " The review_session_proposal is a strategic BRIEF and the ONLY attention prior handed down to the tactical review planner (which reads no memory). Beyond count + estimated_minutes, set: knowledge_focus (ranked knowledge_ids to prioritise, drawn from due/weak signals AND the active_items attention pressure), subject_mix (relative weight per subject), time_box_minutes, and intent_tags. active_items carry the knowledge_ids of the user's in-progress / pinned learning items: treat them as attention pressure that biases knowledge_focus, NEVER as bookkeeping or scheduling state, and never let them suppress the FSRS-due review backbone (ND-5 / D11). When active_items is empty, derive the brief from due/weak signals alone.";
export const COACH_DAILY_OBJECTIVE = `Produce a TodayPlan for the user via the provided DomainTools. Only write proposals (defer / split / relearn / archive / completion / maintenance / knowledge_edge); never mutate user data directly. Prefer doing nothing if the day has no actionable adjustments.${COACH_GOAL_STRAND_GUIDANCE}${COACH_PROPOSAL_FEEDBACK_GUIDANCE}${COACH_AGENT_NOTES_GUIDANCE}${COACH_BRIEF_GUIDANCE}${COACH_SUGGESTION_KIND_GUIDANCE}`;
export const COACH_WEEKLY_OBJECTIVE = `Produce a weekly TodayPlan with a \`weekly_reflection\` summary plus any plan adjustments / maintenance proposals via propose_* tools. Only write proposals; never mutate user data directly.${COACH_GOAL_STRAND_GUIDANCE}${COACH_PROPOSAL_FEEDBACK_GUIDANCE}${COACH_AGENT_NOTES_GUIDANCE}${COACH_BRIEF_GUIDANCE}${COACH_SUGGESTION_KIND_GUIDANCE}`;

// P5.4-L2 / YUK-174 (Facet A, §3.3) — the proposal kinds Coach can ACT on
// (COACH_TOOLS). Coach proposes learning-item lifecycle (completion / relearn /
// defer / archive), knowledge mutations (knowledge_node / archive), and — after
// AB-4 — knowledge_edge. The digest is scoped to these so prompt budget is not
// spent on a kind Coach cannot act on. (record_* / variant / mistake stay out.)
const COACH_ACTABLE_KINDS = new Set([
  'completion',
  'relearn',
  'defer',
  'archive',
  'knowledge_node',
  'knowledge_edge',
]);

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
// YUK-203 U4 / D11① — swappable active learning-item reader (DB tests inject
// fixtures / []). Defaults to listActiveLearningItems. Read-only ADD; the
// items' knowledge_ids are attention pressure only, never the review backbone.
type ListActiveItemsFn = (db: Db) => Promise<ActiveLearningItem[]>;
// P5.4-L2 / YUK-174 (Facet A) — swappable feedback-digest reader (DB tests inject
// fixtures), mirrors ListActiveGoalsFn. No-op on cold start (empty digest).
type LoadProposalFeedbackFn = (db: Db) => Promise<ProposalFeedbackCell[]>;
// codex #3356884494 / AF §4 — swappable agent-note reader (DB tests inject a
// stub / [] so the {}-stub db is never touched). Defaults to
// readAgentNotes(for_agent='coach'). Mirrors dreaming_nightly's ReadAgentNotesFn.
type ReadAgentNotesFn = (db: Db, now: Date) => Promise<AgentNote[]>;

export type CoachRunKind = 'daily' | 'weekly';

export interface CoachRunDeps {
  runAgentTaskFn?: RunAgentTaskFn;
  listProposalInboxRowsFn?: ListProposalInboxRowsFn;
  buildMcpServerFn?: BuildMcpServerFn;
  writeEventFn?: WriteEventFn;
  // YUK-143 / ADR-0025 — defaults to listActiveGoals; goals feed the additive
  // goal strand only and never touch the review backbone (ND-5).
  listActiveGoalsFn?: ListActiveGoalsFn;
  // YUK-203 U4 / D11① — defaults to listActiveLearningItems; feeds active/pinned
  // items' knowledge_ids as the brief's attention pressure. Read-only ADD;
  // never touches the FSRS-due / review backbone (ND-5).
  listActiveItemsFn?: ListActiveItemsFn;
  // P5.4-L2 / YUK-174 — defaults to getProposalFeedbackDigest; feeds the additive
  // reason digest, scoped to Coach's actable kinds. Cold-start inert (ND-5).
  loadProposalFeedbackFn?: LoadProposalFeedbackFn;
  // codex #3356884494 / AF §4 — defaults to readAgentNotes(for_agent='coach').
  // Reads the out-of-band hint channel. Additive only: hints bias attention,
  // never the FSRS-due queue / review backbone (ND-5).
  readAgentNotesFn?: ReadAgentNotesFn;
  now?: () => Date;
}

function buildCoachInput(
  runKind: CoachRunKind,
  now: Date,
  beforeRows: ProposalSnapshotRow[],
  objective: string,
  activeGoals: ActiveGoal[],
  feedbackDigest: ProposalFeedbackCell[],
  agentNotes: AgentNote[],
  activeItems: ActiveLearningItem[],
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
    // YUK-203 U4 / D11① — active/pinned learning items' knowledge_ids as the
    // brief's attention pressure (CO §7.1:723-726). Empty array when no active
    // items → the COACH_BRIEF_GUIDANCE clause derives the brief from due/weak
    // signals alone. Attention pressure ONLY: never bookkeeping (ND-5 / D11).
    active_items: activeItems.map((it) => ({
      id: it.id,
      knowledge_ids: it.knowledge_ids,
      status: it.status,
      user_pinned: it.user_pinned,
    })),
    // P5.4-L2 / YUK-174 (Facet A + C, §3.3) — per-(kind, relation) reason
    // feedback, scoped to the kinds Coach can act on (COACH_ACTABLE_KINDS,
    // including knowledge_edge after AB-4). Bounded by the digest's own cap.
    // Empty on cold start → the COACH_PROPOSAL_FEEDBACK_GUIDANCE clause is inert,
    // plan unchanged.
    proposal_feedback: feedbackDigest
      .filter((cell) => COACH_ACTABLE_KINDS.has(cell.kind))
      .map((cell) => ({
        kind: cell.kind,
        relation: cell.relation,
        acceptance_rate: cell.acceptance_rate,
        accept_count: cell.accept_count,
        dismiss_count: cell.dismiss_count,
        top_dismiss_reasons: cell.top_dismiss_reasons,
        top_rubric_gates: cell.top_rubric_gates,
      })),
    // codex #3356884494 / AF §4 — un-expired out-of-band hints addressed to
    // 'coach'. HINTS, not facts (the COACH_AGENT_NOTES_GUIDANCE clause says so
    // explicitly). Empty array when no fresh notes exist → model behaves exactly
    // as before. Mirrors dreaming_nightly's agent_notes field shape.
    agent_notes: agentNotes.map((n) => ({
      id: n.id,
      signal_kind: n.signal_kind,
      summary_md: n.summary_md,
      refs: n.refs,
      source_task_kind: n.source_task_kind,
      ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
    })),
    budget: {
      // P5.1 / YUK-143 — sourced from COACH_CONTEXT_BUDGET (12 / 5),
      // byte-identical to the prior hardcoded literals.
      max_tool_calls: COACH_CONTEXT_BUDGET.maxToolCalls,
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
      hint: 'Return a JSON object with daily_focus, review_session_proposal, plan_adjustments[], maintenance_proposals[]. review_session_proposal is the strategic BRIEF: set count + estimated_minutes AND the brief fields knowledge_focus[] (ranked knowledge_ids from due/weak + active_items pressure), subject_mix[] ({subject_id, weight}), time_box_minutes, intent_tags[]. Weekly runs additionally set weekly_reflection. When active_goals are present, also set goal_ids[] and goal_strand[] (each item: serves_goal_id, knowledge_ids[], focus) — additive only, never replacing the review backbone (ND-5).',
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
  // YUK-203 U4 / D11① — default to listActiveLearningItems; DB tests inject a
  // stub / [] so the {}-stub db is never touched (mirrors listGoals default).
  const listItems = deps.listActiveItemsFn ?? listActiveLearningItems;
  const loadFeedback =
    deps.loadProposalFeedbackFn ??
    ((db: Db) => getProposalFeedbackDigest(db, PROPOSAL_FEEDBACK_BUDGET));
  // codex #3356884494 / AF §4 — read un-expired hints addressed to Coach.
  const readNotes =
    deps.readAgentNotesFn ??
    ((db: Db, now: Date) => readAgentNotes(db, { for_agent: 'coach', now }));
  const triggerActorRef = runKind === 'daily' ? 'nightly_coach' : 'weekly_coach';
  const objective = runKind === 'daily' ? COACH_DAILY_OBJECTIVE : COACH_WEEKLY_OBJECTIVE;

  const beforeRows = await listRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  // YUK-143 / ADR-0025 — read active goals for the additive goal strand. This is
  // a read-only ADD to the Coach signal set; it does not read the FSRS-due queue
  // or mutate any review state (ND-5).
  const activeGoals = await listGoals(db);
  // P5.4-L2 / YUK-174 (Facet A) — read the feedback digest for the additive
  // reason bias. Read-only ADD; never touches the FSRS-due / review backbone.
  // Empty on cold start → the feed degrades to a no-op.
  const feedbackDigest = await loadFeedback(db);
  // codex #3356884494 / AF §4 — read the un-expired out-of-band hints addressed
  // to Coach (for_agent='coach'). Read-only ADD mirroring dreaming_nightly; hints
  // bias attention only, never the FSRS-due queue / review backbone (ND-5). Empty
  // in the common case → the COACH_AGENT_NOTES_GUIDANCE clause is inert.
  const agentNotes = await readNotes(db, now);
  // YUK-203 U4 / D11① — read active/pinned learning items for the brief's
  // attention pressure. Read-only ADD; never touches the FSRS-due / review
  // backbone (ND-5). Empty in the cold-start case → brief derives from due/weak.
  const activeItems = await listItems(db);
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
      buildCoachInput(
        runKind,
        now,
        beforeRows,
        objective,
        activeGoals,
        feedbackDigest,
        agentNotes,
        activeItems,
      ),
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

// YUK-349 — the coach_daily → review_plan chain-enqueue seam was retired with the B3
// merge engine (the review_plan producer is removed). buildCoachDailyHandler now just
// runs the daily Coach brief; the daily stream is composed by the B3 engine, not a
// chained tactical review_plan run.
export type CoachDailyHandlerDeps = CoachRunDeps;

export function buildCoachDailyHandler(
  db: Db,
  deps: CoachDailyHandlerDeps = {},
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runCoach(db, 'daily', deps);
    console.log('[coach_daily] result', result);
  };
}
