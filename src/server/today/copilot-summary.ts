// Wave 5 / T-D3/B — /today copilot drawer summary.
//
// Composes the drawer's summary slot from existing read paths. Read-only;
// does not call propose_*. The drawer mounts this once when it first
// floats (dwell or revisit) and treats the response as a stable snapshot.
//
// Inputs:
//   • latest experimental:coach_scan event payload  → daily_focus + plan_count
//   • listProposalInboxPage(pending)                 → dreaming_preview rows
//   • material_fsrs_state due count                  → review_due_count
//
// Output is a typed `CopilotSummary` (parallel-build mock target — see
// TodayPlanPlaceholder in coach schema).

import type { Db, Tx } from '@/db/client';
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
  /** Latest pending proposals scan limit. */
  pendingLimit?: number;
  /** How many dreaming-authored items to preview. */
  previewLimit?: number;
}

export async function loadCopilotSummary(
  db: DbLike,
  opts: CopilotSummaryOpts = {},
): Promise<CopilotSummary> {
  const previewLimit = opts.previewLimit ?? 3;

  const [latestCoach, latestDreaming, pendingPage] = await Promise.all([
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
    listProposalInboxPage(db, { status: 'pending', limit: 50 }),
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

  const planAdjustmentsCount =
    typeof coachPayload?.proposals_created === 'number'
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

  return {
    daily_focus: dailyFocus,
    plan_adjustments_count: planAdjustmentsCount,
    dreaming_preview: dreamingPreview,
    pending_proposals_total: pendingPage.rows.length,
    coach_last_run_at: coachEvent ? coachEvent.created_at.toISOString() : null,
    dreaming_last_run_at: dreamingEvent ? dreamingEvent.created_at.toISOString() : null,
  };
}
