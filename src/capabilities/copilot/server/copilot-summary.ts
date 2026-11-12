// /today copilot drawer summary.
//
// Composes a stable snapshot from existing read-only paths; it never calls propose_*.
// Output order follows the drawer's human decision points: daily focus, review due,
// global memory brief, one Dreaming preview, plus footer counters.
//
// The DomainTool execute fns keep their SQL predicates single-sourced; this bypasses the
// MCP bridge (and its ADR-0011 audit) on purpose for a read-only surface.

import type { Db, Tx } from '@/db/client';
import { type EnvelopedEvent, getEvents } from '@/kernel/events';
import {
  PENDING_PROPOSAL_COUNT_BATCH_SIZE,
  PENDING_PROPOSAL_COUNT_MAX_BATCHES,
  countPendingProposalInboxByKind,
  listProposalInboxPage,
} from '@/kernel/proposals/inbox';
import { executeGetReviewDue } from '@/kernel/read-models/review-due';
import type { ToolContext } from '@/kernel/tools/types';
import { executeMemoryBrief } from './tools/memory-brief';

type DbLike = Db | Tx;

// Newest of the two coach outcome picks; getEvents already ordered each list by
// (created_at, dispatch_seq) DESC, so a wall-clock tie falls to the higher dispatch_seq.
function newerCoachEvent(
  success: EnvelopedEvent | undefined,
  degraded: EnvelopedEvent | undefined,
): EnvelopedEvent | null {
  if (!success) return degraded ?? null;
  if (!degraded) return success;
  const dt = success.created_at.getTime() - degraded.created_at.getTime();
  if (dt > 0) return success;
  if (dt < 0) return degraded;
  return success.dispatch_seq >= degraded.dispatch_seq ? success : degraded;
}

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
  /** First paragraph of the global memory brief (capped); null hides the drawer slot. */
  brief_global_md: string | null;
  /** Pending proposals from the last day; probes and variants rank first. */
  dreaming_preview: CopilotSummaryDreamingPreview[];
  /** Snapshot of the pending total; a lower bound only if the scan cap is hit. */
  pending_proposals_total: number;
  /**
   * When Coach last ran (ISO) or null when it hasn't. Includes a degraded run (plan
   * parse failure): Coach did run, and the placeholder focus below is the honest render.
   */
  coach_last_run_at: string | null;
  /** When Dreaming last ran (ISO) or null when it hasn't. */
  dreaming_last_run_at: string | null;
}

// Only claims the summary can verify from its own reads: a due review queue
// exists only when review_due_count > 0; otherwise state the missing plan only.
const COACH_PLACEHOLDER_FOCUS_WITH_QUEUE = 'Coach 还没出新计划，先按到期的复习队列开始即可。';
const COACH_PLACEHOLDER_FOCUS_NO_QUEUE = 'Coach 还没出新计划。';

/** The drawer previews the last day of pending suggestions, not an unbounded backlog. */
const PREVIEW_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A probe is the cheapest way to resolve a belief; a variant targets a proven failure. */
const PREVIEW_FIRST_KINDS = ['conjecture', 'variant_question'] as const;

// The drawer says where a suggestion came from. Internal producer ids never reach the
// learner; an unknown producer gets a neutral label rather than a false attribution.
const PROPOSAL_SOURCE_LABELS: Readonly<Record<string, string>> = {
  dreaming: '夜间整理',
  copilot: '学习伙伴',
  coach: '教练',
  variant_gen: '变体题',
  learning_intent: '学习方向',
  learning_item_maintenance: '学习安排',
  maintenance: '日常维护',
  block_assembly: '内容整理',
  appeal: '申诉复核',
  attribution: '错因归类',
  note_refine: '笔记整理',
  goal_scope: '目标范围',
};

function proposalSourceLabel(actorRef: string): string {
  return PROPOSAL_SOURCE_LABELS[actorRef] ?? '自动整理';
}

const LEARNER_PROPOSAL_SUMMARIES: Readonly<Record<string, string>> = {
  knowledge_node: '有一项知识点建议待你查看。',
  knowledge_edge: '有一项知识关系建议待你查看。',
  knowledge_mutation: '有一项知识内容建议待你查看。',
  learning_item: '有一项学习安排建议待你查看。',
  note_update: '有一项笔记更新建议待你查看。',
  variant_question: '有一项变体题建议待你查看。',
  record_promotion: '有一项学习记录建议待你查看。',
  record_links: '有一项学习记录关联建议待你查看。',
  completion: '有一项完成情况建议待你查看。',
  relearn: '有一项重学建议待你查看。',
  goal_scope: '有一项目标范围建议待你查看。',
  block_merge: '有一项内容整理建议待你查看。',
  defer: '有一项延后安排建议待你查看。',
  archive: '有一项归档建议待你查看。',
  judge_retraction: '有一项判定撤回建议待你查看。',
  cause_category: '有一项错因分类建议待你查看。',
  question_draft: '有一项题目草稿建议待你查看。',
  question_edit: '有一项题目修订建议待你查看。',
  conjecture: '有一项诊断判断建议待你查看。',
};

export function learnerProposalSummary(kind: string): string {
  return LEARNER_PROPOSAL_SUMMARIES[kind] ?? '有一项学习建议待你查看。';
}

export interface CopilotSummaryOpts {
  /** How many dreaming-authored items to preview. */
  previewLimit?: number;
  /** Hard cap on brief_global_md after first-paragraph slice. Default 280. */
  briefCharCap?: number;
  /** Upper bound on the review-due fetch (1..50; 50 renders a stable "50+" bound). */
  reviewDueLimit?: number;
  /** Batch/cap knobs forwarded to countPendingProposalInboxByKind; tests shrink them to hit the cap. */
  pendingCountOptions?: { batchSize?: number; maxBatches?: number };
}

export async function loadCopilotSummary(
  db: DbLike,
  opts: CopilotSummaryOpts = {},
): Promise<CopilotSummary> {
  // Clamp before the options reach executeGetReviewDue's Zod schema; previewLimit and
  // briefCharCap floor at 1, and reviewDueLimit stays in 1..50.
  const previewLimit = Math.max(1, opts.previewLimit ?? 3);
  const previewWindowStart = new Date(Date.now() - PREVIEW_WINDOW_MS);
  const briefCharCap = Math.max(1, opts.briefCharCap ?? 280);
  const reviewDueLimit = Math.min(50, Math.max(1, opts.reviewDueLimit ?? 50));

  // Synthetic ToolContext for non-MCP reuse: the execute fns only need `ctx.db`, and no
  // events are written.
  const toolCtx: ToolContext = {
    db: db as ToolContext['db'],
    taskRunId: 'today-copilot-summary',
    callerActor: { kind: 'system', ref: 'today-copilot-summary' },
  };

  const [
    latestCoachSuccess,
    latestCoachDegraded,
    latestDreaming,
    pendingCounts,
    dreamingPage,
    dueOutput,
    briefOutput,
  ] = await Promise.all([
    getEvents(db, {
      action: 'experimental:coach_scan',
      outcome: 'success',
      limit: 1,
    }),
    // A degraded run (plan parse failure) must outrank an older success: the placeholder
    // focus is the honest render for "ran but produced no plan", never a stale plan
    // presented as current. Crashed runs (outcome 'failure') stay excluded below.
    getEvents(db, {
      action: 'experimental:coach_scan',
      outcome: 'degraded',
      limit: 1,
    }),
    getEvents(db, {
      action: 'experimental:dreaming_scan',
      outcome: 'success',
      limit: 1,
    }),
    // The by-kind counter skips the joins and sorting a full inbox projection pays on
    // every /today load. `?? undefined` guards a caller passing null, which default
    // parameters do not replace.
    countPendingProposalInboxByKind(db, opts.pendingCountOptions ?? undefined),
    // A one-day window keeps the drawer about today; probes and variants outrank the rest
    // so an old backlog cannot push the newest actionable suggestion out of the preview.
    listProposalInboxPage(db, {
      status: 'pending',
      createdAfter: previewWindowStart,
      kindFirst: PREVIEW_FIRST_KINDS,
      limit: previewLimit,
    }),
    // Reuse the execute fn so the due predicate stays single-sourced.
    executeGetReviewDue(toolCtx, { limit: reviewDueLimit }),
    executeMemoryBrief(toolCtx, { scopeKey: 'global' }),
  ]);

  const coachEvent = newerCoachEvent(latestCoachSuccess[0], latestCoachDegraded[0]);
  const dreamingEvent = latestDreaming[0] ?? null;
  const coachPayload = (coachEvent?.payload as Record<string, unknown> | undefined) ?? null;
  // daily_focus sits at the payload top level or under payload.today_plan; the write
  // side already checked numeric claims, and historical events predate that check.
  const todayPlanInPayload = coachPayload?.today_plan as Record<string, unknown> | undefined;
  const coachDailyFocus =
    (typeof coachPayload?.daily_focus === 'string' ? coachPayload.daily_focus : null) ||
    (typeof todayPlanInPayload?.daily_focus === 'string'
      ? (todayPlanInPayload.daily_focus as string)
      : null);

  // Prefer TodayPlan counts; fall back to the cron counter, then null when Coach hasn't run.
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

  const dreamingPreview: CopilotSummaryDreamingPreview[] = dreamingPage.rows.map((row) => ({
    proposal_id: row.id,
    kind: row.kind,
    brief: `${proposalSourceLabel(row.actor_ref)}：${learnerProposalSummary(row.kind)}`,
    proposed_at:
      row.proposed_at instanceof Date ? row.proposed_at.toISOString() : String(row.proposed_at),
  }));

  // Equivalent to the old full inbox projection for this proposal set. On a cap hit, warn
  // and serve the lower bound rather than pay the unbounded join on the hot path exactly
  // when the backlog is largest.
  const pendingProposalsTotal = Object.values(pendingCounts.byKind).reduce(
    (sum, kindCount) => sum + (kindCount ?? 0),
    0,
  );
  if (pendingCounts.hasMore) {
    const batchSize = opts.pendingCountOptions?.batchSize ?? PENDING_PROPOSAL_COUNT_BATCH_SIZE;
    const maxBatches = opts.pendingCountOptions?.maxBatches ?? PENDING_PROPOSAL_COUNT_MAX_BATCHES;
    console.warn(
      'loadCopilotSummary: pending proposal count hit its scan cap; pending_proposals_total is a lower bound',
      {
        lowerBound: pendingProposalsTotal,
        byKind: pendingCounts.byKind,
        cap: batchSize * maxBatches,
      },
    );
  }

  // Capped at reviewDueLimit (max 50); the drawer renders "50" as a stable upper bound,
  // and the full review queue is the dedicated /today route's job.
  const reviewDueCount = dueOutput.queue_summary.total_returned;
  const dailyFocus =
    coachDailyFocus !== null
      ? coachDailyFocus
      : reviewDueCount > 0
        ? COACH_PLACEHOLDER_FOCUS_WITH_QUEUE
        : COACH_PLACEHOLDER_FOCUS_NO_QUEUE;
  const briefRaw = briefOutput.note?.recent_week_md ?? null;
  // First paragraph, capped so the drawer stays compact; null when empty or whitespace.
  const briefGlobalMd = briefRaw
    ? briefRaw.split('\n\n')[0]?.slice(0, briefCharCap).trim() || null
    : null;

  return {
    daily_focus: dailyFocus,
    plan_adjustments_count: planAdjustmentsCount,
    review_due_count: reviewDueCount,
    brief_global_md: briefGlobalMd,
    dreaming_preview: dreamingPreview,
    pending_proposals_total: pendingProposalsTotal,
    coach_last_run_at: coachEvent ? coachEvent.created_at.toISOString() : null,
    dreaming_last_run_at: dreamingEvent ? dreamingEvent.created_at.toISOString() : null,
  };
}
