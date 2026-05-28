// Wave 5 / T-D3/B — /today copilot drawer summary.
//
// Composes the drawer's summary slot from existing read paths. Read-only;
// does not call propose_*. The drawer mounts this once when it first
// floats (dwell or revisit) and treats the response as a stable snapshot.
//
// Output order per Wave 5 ready-to-launch lock §Human decision points:
//   ① Coach `TodayPlan.daily_focus`
//   ② `review_due_count` (FSRS due-question count, via executeGetReviewDue)
//   ③ `brief_global_md`  (first paragraph of executeMemoryBrief scope='global')
//   ④ one Dreaming proposal preview
// Plus footer counters (Coach last-run, pending total).
//
// Inputs (all read-only; we reuse the DomainTool `execute` fns so the SQL
// predicate stays single-sourced — ADR-0011 audit only fires when the call
// goes through the MCP bridge, which we bypass here):
//   • latest experimental:coach_scan event payload  → daily_focus + plan_count
//   • executeGetReviewDue({ limit })                 → review_due_count
//   • executeMemoryBrief({ scopeKey: 'global' })     → brief_global_md
//   • listProposalInboxPage(pending)                 → dreaming_preview rows
//
// Output is a typed `CopilotSummary` (parallel-build mock target — see
// TodayPlanPlaceholder in coach schema).

import type { Db, Tx } from '@/db/client';
import { executeGetReviewDue, executeMemoryBrief } from '@/server/ai/tools/context-readers';
import type { ToolContext } from '@/server/ai/tools/types';
import { getEvents } from '@/server/events/queries';
import { listProposalInboxPage } from '@/server/proposals/inbox';

type DbLike = Db | Tx;

export interface CopilotSummaryDreamingPreview {
  proposal_id: string;
  kind: string;
  brief: string;
  proposed_at: string;
}

export interface CopilotSummary {
  /** Always present; falls back to a placeholder when Coach hasn't run yet. */
  daily_focus: string;
  /** Coach plan_adjustments + maintenance_proposals total from latest scan. */
  plan_adjustments_count: number | null;
  /** FSRS review-due signal: question rows with `due_at <= now`. */
  review_due_count: number;
  /**
   * First paragraph of the global memory brief (capped at 280 chars). Null
   * when `memory_brief_note WHERE scope_key='global'` has no row or empty
   * `recent_week_md`. The drawer hides this slot when null.
   */
  brief_global_md: string | null;
  /** Pending Dreaming-authored proposals (latest 3). */
  dreaming_preview: CopilotSummaryDreamingPreview[];
  /** Snapshot of pending proposal totals. */
  pending_proposals_total: number;
  /** When Coach last ran (ISO) or null when it hasn't. */
  coach_last_run_at: string | null;
  /** When Dreaming last ran (ISO) or null when it hasn't. */
  dreaming_last_run_at: string | null;
}

const COACH_PLACEHOLDER_FOCUS = '昨晚 Coach 还没出新计划，先按你昨天排的复习队列开始即可。';

export interface CopilotSummaryOpts {
  /** How many dreaming-authored items to preview. */
  previewLimit?: number;
  /** Hard cap on brief_global_md after first-paragraph slice. Default 280. */
  briefCharCap?: number;
  /**
   * Upper bound on the review-due fetch via executeGetReviewDue. The tool's
   * schema caps this at 50; we ask for 50 by default so the drawer shows a
   * stable "50+" upper bound when the queue is large. Use 1..50 in tests to
   * exercise the actual count.
   */
  reviewDueLimit?: number;
}

export async function loadCopilotSummary(
  db: DbLike,
  opts: CopilotSummaryOpts = {},
): Promise<CopilotSummary> {
  const previewLimit = opts.previewLimit ?? 3;
  const briefCharCap = opts.briefCharCap ?? 280;
  const reviewDueLimit = opts.reviewDueLimit ?? 50;

  // Synthetic ToolContext for non-MCP read-path reuse. The execute fns
  // (executeGetReviewDue / executeMemoryBrief) only touch `ctx.db`; the
  // `taskRunId` and `callerActor` fields exist purely so we don't have to
  // weaken their type signatures. No events are written.
  const toolCtx: ToolContext = {
    db: db as ToolContext['db'],
    taskRunId: 'today-copilot-summary',
    callerActor: { kind: 'system', ref: 'today-copilot-summary' },
  };

  const [latestCoach, latestDreaming, pendingPage, dueOutput, briefOutput] = await Promise.all([
    getEvents(db, {
      action: 'experimental:coach_scan',
      outcome: 'success',
      limit: 1,
    }),
    getEvents(db, {
      action: 'experimental:dreaming_scan',
      outcome: 'success',
      limit: 1,
    }),
    // No `limit` — we need the exact total for `pending_proposals_total`.
    // listProposalInboxPage with limit=undefined projects all pending rows
    // in a single ranked query (see loadProposalEvents). On a single-user
    // system this is bounded; if it grows we'll swap to a dedicated
    // count(*) helper.
    listProposalInboxPage(db, { status: 'pending' }),
    // FSRS review-due signal — reuse the DomainTool execute fn so the
    // predicate (subject_kind='question' AND due_at <= now + never-reviewed
    // failures backfill) stays single-sourced. Schema caps `limit` at 50.
    executeGetReviewDue(toolCtx, { limit: reviewDueLimit }),
    // Global memory brief gestalt (single row by unique scope_key).
    executeMemoryBrief(toolCtx, { scopeKey: 'global' }),
  ]);

  const coachEvent = latestCoach[0] ?? null;
  const dreamingEvent = latestDreaming[0] ?? null;
  const coachPayload = (coachEvent?.payload as Record<string, unknown> | undefined) ?? null;
  // CoachTask returns a TodayPlan JSON; daily_focus shows up either at the
  // top level of the scan payload (experimental:coach_scan record) or under
  // payload.today_plan when the worker copies the result through. Prefer
  // either path; fall back to the placeholder.
  const dailyFocus =
    (typeof coachPayload?.daily_focus === 'string' ? coachPayload.daily_focus : null) ||
    (typeof (coachPayload?.today_plan as Record<string, unknown> | undefined)?.daily_focus ===
    'string'
      ? ((coachPayload?.today_plan as Record<string, unknown>).daily_focus as string)
      : null) ||
    COACH_PLACEHOLDER_FOCUS;

  // Prefer the TodayPlan-derived count (plan_adjustments + maintenance) when
  // available; fall back to the cron run's proposals_created counter; finally
  // null when Coach hasn't run yet.
  const todayPlanInPayload = coachPayload?.today_plan as Record<string, unknown> | undefined;
  const planAdjustmentsArr = Array.isArray(todayPlanInPayload?.plan_adjustments)
    ? (todayPlanInPayload?.plan_adjustments as unknown[])
    : null;
  const maintenanceArr = Array.isArray(todayPlanInPayload?.maintenance_proposals)
    ? (todayPlanInPayload?.maintenance_proposals as unknown[])
    : null;
  const planAdjustmentsCount =
    planAdjustmentsArr || maintenanceArr
      ? (planAdjustmentsArr?.length ?? 0) + (maintenanceArr?.length ?? 0)
      : typeof coachPayload?.proposals_created === 'number'
        ? (coachPayload.proposals_created as number)
        : null;

  const dreamingPreview: CopilotSummaryDreamingPreview[] = pendingPage.rows
    .filter((row) => row.actor_ref === 'dreaming')
    .slice(0, previewLimit)
    .map((row) => ({
      proposal_id: row.id,
      kind: row.kind,
      brief: row.payload.reason_md.slice(0, 200),
      proposed_at:
        row.proposed_at instanceof Date ? row.proposed_at.toISOString() : String(row.proposed_at),
    }));

  // `total_returned` matches the rows array length — capped at
  // `reviewDueLimit` (max 50 per GetReviewDueInputSchema). For queue sizes
  // beyond that the drawer renders "50" as a stable upper bound; the full
  // review queue is the dedicated `/today` route's job.
  const reviewDueCount = dueOutput.queue_summary.total_returned;
  const briefRaw = briefOutput.note?.recent_week_md ?? null;
  // Take the first paragraph (split on the first \n\n boundary) and cap at
  // `briefCharCap` so the drawer stays compact. Null when row missing or
  // the column is empty/whitespace.
  const briefGlobalMd = briefRaw
    ? briefRaw.split('\n\n')[0]?.slice(0, briefCharCap).trim() || null
    : null;

  return {
    daily_focus: dailyFocus,
    plan_adjustments_count: planAdjustmentsCount,
    review_due_count: reviewDueCount,
    brief_global_md: briefGlobalMd,
    dreaming_preview: dreamingPreview,
    pending_proposals_total: pendingPage.rows.length,
    coach_last_run_at: coachEvent ? coachEvent.created_at.toISOString() : null,
    dreaming_last_run_at: dreamingEvent ? dreamingEvent.created_at.toISOString() : null,
  };
}
