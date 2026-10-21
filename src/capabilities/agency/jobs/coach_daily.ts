// coach_daily pg-boss handler: builds the Coach allowlist MCP bridge, runs
// `CoachTask`, and writes trigger + scan events (`experimental:trigger_coach_scan` /
// `experimental:coach_scan`).

import type { Job } from 'pg-boss';
// The complete run assembly (inbox before/after diff, trigger + scan provenance events,
// budget tracker + propose-cap gate, piDomainMount wiring, hard+1 budgetOverride,
// runAgentTask call, failure event + rethrow) is owned by runAgencyProposalScan. This job
// keeps only the Coach signal reads, the input build, and the TodayPlan parse.
import {
  type AgencyScanInboxRow,
  type AgencyScanRunFn,
  runAgencyProposalScan,
} from '@/capabilities/agency/server/agent-run';
// Coach consumes the out-of-band agent-note HINT channel (for_agent='coach'), where
// quiz_verify leaves question_pool_gap notes. Hints, not facts; additive only.
import { type AgentNote, readAgentNotes } from '@/capabilities/agency/server/notes';
import {
  type DailyReviewPlanInputs,
  resolveDailyReviewPlanInputs,
} from '@/capabilities/practice/public';
import { type ReviewPlanNumbers, computeReviewPlanNumbers } from '@/core/daily-review-plan';
import { CoachPlanDraft, type CoachPlanDraftT, composeTodayPlan } from '@/core/schema/coach';
import type { Db } from '@/db/client';
import type { WriteEventInput } from '@/kernel/events';
// Per-(kind, relation) accept-learned reason digest for the Coach input, scoped to the
// kinds Coach can act on (includes knowledge_edge). Purely additive / cold-start inert.
import {
  type ProposalFeedbackCell,
  getProposalFeedbackDigest,
} from '@/kernel/proposals/adaptive-bias';
// Active goals feed the additive goal-oriented strand; the FSRS-due / review backbone
// and other capture tasks are untouched.
import {
  type ActiveGoal,
  listActiveGoalsWithResolvedScope,
} from '@/kernel/read-models/active-goal-scope';
// Single tunable source for Coach run caps.
import { COACH_CONTEXT_BUDGET, PROPOSAL_FEEDBACK_BUDGET } from '@/kernel/tools/budgets';
// Active/pinned learning items' knowledge_ids feed the Coach input as ATTENTION PRESSURE
// only; never scheduling/bookkeeping, never the FSRS-due review backbone.
import { type ActiveLearningItem, listActiveLearningItems } from '@/server/learning-items/queries';

// Re-exported alias kept for existing imports; sourced from COACH_CONTEXT_BUDGET.maxProposals.
export const COACH_MAX_PROPOSALS = COACH_CONTEXT_BUDGET.maxProposals as number;
// Goal-strand guidance appended to the Coach objective (additive only).
const COACH_GOAL_STRAND_GUIDANCE =
  ' If active_goals are provided, additionally add a goal-oriented strand: set TodayPlan.goal_ids to the goals you address and add goal_strand items (each tagged serves_goal_id + knowledge_ids). Distribute attention across active goals (round-robin + weakest-scope first). CRITICAL: the goal strand is purely additive direction — it must NOT suppress or replace the FSRS-due review backbone, hide other capture tasks, preempt the daily review quota, or change any due times. If there are no active goals, omit the goal strand.';
// Reason-feedback clause: empty proposal_feedback (cold start) makes it inert.
const COACH_PROPOSAL_FEEDBACK_GUIDANCE =
  ' When proposal_feedback is present, each entry is a (kind, relation) cell carrying top_dismiss_reasons (why the user dismissed) and, for knowledge_edge cells, top_rubric_gates (why the rubric rejected) — read them as the specific failure mode and avoid repeating it; additive only, never suppress or replace the review backbone or signal-driven proposals (ND-5). Only propose a knowledge_edge when a concrete mistake pattern shows two knowledge points are confused / ordered / applied together AND that relation has not been routinely dismissed; otherwise skip the edge. When proposal_feedback is empty, behave exactly as before.';
// Suggestion-kind guidance: corrective is purely the model's explicit label — there is
// no deterministic post-process fallback.
const COACH_SUGGESTION_KIND_GUIDANCE =
  " On each propose_* tool call set the optional suggestion_kind argument: use 'proactive' (the default — omit it) when you are proposing a next step off a successful read; use 'corrective' ONLY when the proposal repairs a specific failure you yourself just observed. A read that returns zero results is a legitimate success (you looked and found nothing), NOT a failure — do NOT label a proposal corrective merely because an upstream read came back empty. Only a genuine repair of an observed failure is corrective.";
// Agent-note clause: hints bias attention only, never ground truth, never suppress the
// review backbone or signal-driven proposals. Inert when agent_notes is empty.
const COACH_AGENT_NOTES_GUIDANCE =
  ' When agent_notes are present, treat each as a soft HINT (not a fact) left by a narrow task — it has a signal_kind, refs, and confidence; use it to direct attention when shaping the plan, never as ground truth, and never let it suppress or replace the FSRS-due review backbone or signal-driven proposals (ND-5). When agent_notes is empty, behave exactly as before.';
// Brief guidance: count / estimated_minutes / time_box_minutes / subject_mix are
// system-computed read-only facts supplied in `review_plan`; the model owns only
// knowledge_focus and intent_tags. active_items are attention pressure only (never
// bookkeeping/scheduling) and must never suppress the FSRS-due review backbone.
const COACH_BRIEF_GUIDANCE =
  " The review_session_proposal is a strategic BRIEF. Its count, estimated_minutes, time_box_minutes and subject_mix are computed by the system from the due queue and the daily budget and are supplied in `review_plan`; treat them as read-only facts and do not output or estimate your own numbers. You own knowledge_focus (ranked knowledge_ids to prioritise, drawn from due/weak signals AND the active_items attention pressure) and intent_tags. active_items carry the knowledge_ids of the user's in-progress / pinned learning items: treat them as attention pressure that biases knowledge_focus, NEVER as bookkeeping or scheduling state, and never let them suppress the FSRS-due review backbone (ND-5 / D11). When active_items is empty, derive knowledge_focus from due/weak signals alone.";
export const COACH_DAILY_OBJECTIVE = `Produce a TodayPlan draft for the user via the provided DomainTools. Only write proposals (defer / split / relearn / archive / completion / maintenance / knowledge_edge); never mutate user data directly. Prefer doing nothing if the day has no actionable adjustments.${COACH_GOAL_STRAND_GUIDANCE}${COACH_PROPOSAL_FEEDBACK_GUIDANCE}${COACH_AGENT_NOTES_GUIDANCE}${COACH_BRIEF_GUIDANCE}${COACH_SUGGESTION_KIND_GUIDANCE}`;
export const COACH_WEEKLY_OBJECTIVE = `Produce a weekly TodayPlan draft with a \`weekly_reflection\` summary plus any plan adjustments / maintenance proposals via propose_* tools. Only write proposals; never mutate user data directly.${COACH_GOAL_STRAND_GUIDANCE}${COACH_PROPOSAL_FEEDBACK_GUIDANCE}${COACH_AGENT_NOTES_GUIDANCE}${COACH_BRIEF_GUIDANCE}${COACH_SUGGESTION_KIND_GUIDANCE}`;

// Kinds Coach can act on; the digest is scoped to these so prompt budget isn't spent on
// kinds Coach cannot act on.
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

type ProposalSnapshotRow = AgencyScanInboxRow;
type ListProposalInboxRowsFn = (db: Db) => Promise<ProposalSnapshotRow[]>;
type WriteEventFn = (db: Db, input: WriteEventInput) => Promise<string>;
// Swappable readers: DB tests inject fixtures / [].
type ListActiveGoalsFn = (db: Db) => Promise<ActiveGoal[]>;
type ListActiveItemsFn = (db: Db) => Promise<ActiveLearningItem[]>;
type LoadProposalFeedbackFn = (db: Db) => Promise<ProposalFeedbackCell[]>;
type ReadAgentNotesFn = (db: Db, now: Date) => Promise<AgentNote[]>;
type ResolvePlanInputsFn = (db: Db) => Promise<DailyReviewPlanInputs>;

export type CoachRunKind = 'daily' | 'weekly';

export interface CoachRunDeps {
  runAgentTaskFn?: AgencyScanRunFn;
  listProposalInboxRowsFn?: ListProposalInboxRowsFn;
  writeEventFn?: WriteEventFn;
  listActiveGoalsFn?: ListActiveGoalsFn;
  listActiveItemsFn?: ListActiveItemsFn;
  loadProposalFeedbackFn?: LoadProposalFeedbackFn;
  readAgentNotesFn?: ReadAgentNotesFn;
  // Injects the due + budget + pace facts.
  resolvePlanInputsFn?: ResolvePlanInputsFn;
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
  reviewPlan: ReviewPlanNumbers & {
    due_count: number;
    budget_minutes: number;
    question_minutes: number;
    question_minutes_source: 'observed' | 'default';
    question_minutes_sample_count: number;
  },
) {
  return {
    run_kind: runKind,
    now: now.toISOString(),
    pending_proposals_before: beforeRows.filter((row) => row.status === 'pending').length,
    objective,
    // Ordered by sequence_hint then created_at; empty means the model omits the strand.
    active_goals: activeGoals.map((g) => ({
      id: g.id,
      title: g.title,
      subject_id: g.subject_id,
      scope_knowledge_ids: g.scope_knowledge_ids,
      sequence_hint: g.sequence_hint,
    })),
    // Attention pressure only; empty means the brief derives from due/weak signals.
    active_items: activeItems.map((it) => ({
      id: it.id,
      knowledge_ids: it.knowledge_ids,
      status: it.status,
      user_pinned: it.user_pinned,
    })),
    // Scoped to actable kinds; bounded by the digest's own cap.
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
    // Un-expired out-of-band hints addressed to 'coach'; hints, not facts.
    agent_notes: agentNotes.map((n) => ({
      id: n.id,
      signal_kind: n.signal_kind,
      summary_md: n.summary_md,
      refs: n.refs,
      source_task_kind: n.source_task_kind,
      ...(n.confidence !== undefined ? { confidence: n.confidence } : {}),
    })),
    // Read-only plan facts; the model never owns these numbers.
    review_plan: reviewPlan,
    budget: {
      // Advisory warning; max_tool_calls is the higher hard ceiling.
      warning_tool_calls: COACH_CONTEXT_BUDGET.toolCalls.warning,
      max_tool_calls: COACH_CONTEXT_BUDGET.toolCalls.hard,
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
      hint: 'Return a JSON object with daily_focus, review_session_proposal, plan_adjustments[], maintenance_proposals[]. review_session_proposal contains only knowledge_focus[] (ranked knowledge_ids from due/weak + active_items pressure) and intent_tags[]; do NOT output count, estimated_minutes, time_box_minutes or subject_mix — the system computes those from review_plan and overwrites them. Weekly runs additionally set weekly_reflection. When active_goals are present, also set goal_ids[] and goal_strand[] (each item: serves_goal_id, knowledge_ids[], focus) — additive only, never replacing the review backbone (ND-5).',
    },
  };
}

export async function runCoach(
  db: Db,
  runKind: CoachRunKind,
  deps: CoachRunDeps = {},
): Promise<CoachRunResult> {
  // Resolved read: subject_live goals derive their scope from subject_id; the frozen
  // column is [] for them.
  const listGoals = deps.listActiveGoalsFn ?? listActiveGoalsWithResolvedScope;
  const listItems = deps.listActiveItemsFn ?? listActiveLearningItems;
  const loadFeedback =
    deps.loadProposalFeedbackFn ??
    ((db: Db) => getProposalFeedbackDigest(db, PROPOSAL_FEEDBACK_BUDGET));
  const readNotes =
    deps.readAgentNotesFn ??
    ((db: Db, now: Date) => readAgentNotes(db, { for_agent: 'coach', now }));
  const triggerActorRef = runKind === 'daily' ? 'nightly_coach' : 'weekly_coach';
  const objective = runKind === 'daily' ? COACH_DAILY_OBJECTIVE : COACH_WEEKLY_OBJECTIVE;

  return runAgencyProposalScan(db, {
    surface: 'coach',
    taskKind: 'CoachTask',
    triggerActorRef,
    budget: COACH_CONTEXT_BUDGET,
    deps: {
      now: deps.now,
      writeEventFn: deps.writeEventFn,
      listProposalInboxRowsFn: deps.listProposalInboxRowsFn,
      runAgentTaskFn: deps.runAgentTaskFn,
    },
    extraTriggerPayload: { run_kind: runKind },
    extraScanFailurePayload: { run_kind: runKind },
    buildScanSuccessPayloadExtras: (taskResult, input) => {
      // Persist the composed plan: `/api/today/copilot-summary` reads `payload.daily_focus`
      // (and `payload.today_plan.daily_focus`) off the latest `experimental:coach_scan`.
      // Invalid model output falls through to the placeholder copy. The reviewPlan computed
      // in prepareInput rides the same built input, so this payload needs no re-read.
      const { review_plan: reviewPlan } = input as ReturnType<typeof buildCoachInput>;
      const todayPlanDraft = parseCoachOutputSafely(taskResult.text ?? '');
      const todayPlan = todayPlanDraft ? composeTodayPlan(todayPlanDraft, reviewPlan) : null;
      return {
        run_kind: runKind,
        // Why these numbers, so a replay can verify them.
        review_plan_basis: {
          due_count: reviewPlan.due_count,
          budget_minutes: reviewPlan.budget_minutes,
          question_minutes: reviewPlan.question_minutes,
          question_minutes_source: reviewPlan.question_minutes_source,
          question_minutes_sample_count: reviewPlan.question_minutes_sample_count,
          count: reviewPlan.count,
          estimated_minutes: reviewPlan.estimated_minutes,
          subject_mix: reviewPlan.subject_mix,
        },
        ...(todayPlan
          ? { today_plan: todayPlan, daily_focus: todayPlan.daily_focus }
          : { today_plan: null, plan_parse_error: true }),
      };
    },
    prepareInput: async ({ now, beforeRows }) => {
      const activeGoals = await listGoals(db);
      const feedbackDigest = await loadFeedback(db);
      const agentNotes = await readNotes(db, now);
      const activeItems = await listItems(db);
      // Read before the trigger write and outside the scan failure boundary, closing over
      // the same anchored `now` the trigger event uses. The computed facts ride the input
      // and the success payload.
      const loadPlanInputs =
        deps.resolvePlanInputsFn ?? ((db: Db) => resolveDailyReviewPlanInputs(db, now));
      const planInputs = await loadPlanInputs(db);
      const reviewPlan = {
        ...computeReviewPlanNumbers({
          budget_minutes: planInputs.budget_minutes,
          question_minutes: planInputs.question_minutes,
          due_by_subject: planInputs.due_by_subject,
        }),
        due_count: planInputs.due_count,
        budget_minutes: planInputs.budget_minutes,
        question_minutes: planInputs.question_minutes,
        question_minutes_source: planInputs.question_minutes_source,
        question_minutes_sample_count: planInputs.question_minutes_sample_count,
      };
      return () =>
        buildCoachInput(
          runKind,
          now,
          beforeRows,
          objective,
          activeGoals,
          feedbackDigest,
          agentNotes,
          activeItems,
          reviewPlan,
        );
    },
  });
}

/**
 * Best-effort `CoachPlanDraft` parse. Live models sometimes wrap the JSON in prose,
 * code fences, or partial JSON; on total failure return `null` so the reader falls back
 * to placeholder copy instead of crashing the cron run.
 */
export function parseCoachOutputSafely(rawText: string): CoachPlanDraftT | null {
  if (!rawText) return null;
  const candidates: string[] = [rawText];
  const fenceMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) candidates.unshift(fenceMatch[1]);
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return CoachPlanDraft.parse(parsed);
    } catch {
      // Try the next candidate; final return below handles total failure.
    }
  }
  return null;
}

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
