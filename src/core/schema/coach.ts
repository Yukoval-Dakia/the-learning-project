// Global Coach Orchestrator result schema.
//
// `CoachTask` produces a `CoachPlanDraft` (prose + proposals + attention tags).
// `coach_daily` composes the `TodayPlan` persisted in the `coach_scan` event:
// count / minutes / time box / subject mix come from the due queue + daily
// budget, never from the model. The shape is shared with the
// `/today` drawer summary endpoint so Coach output renders directly in the
// first-paint slot.

import { z } from 'zod';
import { guardDailyFocusClaims } from '@/core/daily-focus-guard';
import type { ReviewPlanNumbers } from '@/core/daily-review-plan';

export const PlanAdjustmentKind = z.enum(['defer', 'split', 'relearn', 'archive']);
export type PlanAdjustmentKindT = z.infer<typeof PlanAdjustmentKind>;

export const PlanAdjustment = z.object({
  kind: PlanAdjustmentKind,
  learning_item_id: z.string().min(1),
  reasoning: z.string().min(1).max(2000).optional(),
});
export type PlanAdjustmentT = z.infer<typeof PlanAdjustment>;

// Strategic review brief: the single attention prior handed down to
// ReviewPlanTask (CO §6:621-622, no new artifact type). The brief fields are
// optional/defaulted so plans emitted before they existed (and re-parsed by
// parseTodayPlan) still parse unchanged.
//
// `count` / `estimated_minutes` / `time_box_minutes` / `subject_mix`
// are written by `composeTodayPlan` from the due queue + daily budget, never by
// the model. The model-facing shape is `CoachPlanDraft` below.
//
//   - knowledge_focus  — ranked knowledge_ids to prioritise (from due/weak +
//     active-item attention pressure). Empty = no prior.
//   - subject_mix      — planned question count per subject for the session.
//   - time_box_minutes — soft cap on the session length the plan should target.
//   - intent_tags      — free-form session intent labels (e.g. 'weak_recovery',
//     'goal_push') the planner can honour.
export const ReviewSessionProposal = z.object({
  count: z.number().int().nonnegative(),
  estimated_minutes: z.number().int().nonnegative(),
  knowledge_focus: z.array(z.string().min(1)).default([]),
  subject_mix: z
    .array(z.object({ subject_id: z.string().min(1), weight: z.number().nonnegative() }))
    .default([]),
  time_box_minutes: z.number().int().nonnegative().optional(),
  intent_tags: z.array(z.string().min(1)).default([]),
});
export type ReviewSessionProposalT = z.infer<typeof ReviewSessionProposal>;

/** Model-owned half of the review brief: attention tags only, no arithmetic. */
export const CoachReviewBriefDraft = z.object({
  knowledge_focus: z.array(z.string().min(1)).default([]),
  intent_tags: z.array(z.string().min(1)).default([]),
});
export type CoachReviewBriefDraftT = z.infer<typeof CoachReviewBriefDraft>;

export const AtMostOneNewItem = z.object({
  learning_item_id: z.string().min(1),
  title: z.string().min(1),
});
export type AtMostOneNewItemT = z.infer<typeof AtMostOneNewItem>;

export const MaintenanceProposal = z.object({
  kind: z.string().min(1),
  payload: z.unknown().optional(),
});
export type MaintenanceProposalT = z.infer<typeof MaintenanceProposal>;

// ADR-0025 — North-Star goal strand. One item = "today's goal-oriented
// action toward goal X, touching these knowledge nodes". This strand is PURELY
// ADDITIVE to the plan (ND-5): it never suppresses FSRS-due reviews or other
// capture tasks, never preempts daily quota, never changes due times. It only
// adds direction + provenance tags (every item is traceable to a `serves_goal_id`
// — that traceability is the "sense of direction" payoff, spec §5). It also
// closes the graph-signals gap: plan items now carry `knowledge_ids` so Coach
// output knows which nodes an action touches.
export const GoalStrandItem = z.object({
  // which active goal this action serves (← direction-sense provenance tag).
  serves_goal_id: z.string().min(1),
  // knowledge nodes this action touches.
  knowledge_ids: z.array(z.string().min(1)).default([]),
  // one-line description of the goal-oriented action for the day.
  focus: z.string().min(1).max(280),
});
export type GoalStrandItemT = z.infer<typeof GoalStrandItem>;

export const COACH_MAX_GOAL_STRAND_ITEMS = 5;

export const TodayPlan = z.object({
  daily_focus: z.string().min(1).max(280),
  review_session_proposal: ReviewSessionProposal,
  at_most_one_new_item: AtMostOneNewItem.optional(),
  // Only set when the plan is produced by `coach_weekly`.
  weekly_reflection: z.string().min(1).max(1200).optional(),
  plan_adjustments: z.array(PlanAdjustment).max(8),
  maintenance_proposals: z.array(MaintenanceProposal).max(8),
  // ADR-0025 — active goals this plan addresses + the goal-oriented
  // strand. Both optional + default-empty so plans produced before North-Star
  // (or by a model that emits no goal strand) parse unchanged. ND-5: these are
  // additive direction tags only — the review backbone above is untouched.
  goal_ids: z.array(z.string().min(1)).default([]),
  goal_strand: z.array(GoalStrandItem).max(COACH_MAX_GOAL_STRAND_ITEMS).default([]),
});
export type TodayPlanT = z.infer<typeof TodayPlan>;

/**
 * The model's TodayPlan contribution: prose, attention tags, and
 * proposals. The review arithmetic stays out of this shape so a model-emitted
 * count can never be mistaken for plan truth.
 */
export const CoachPlanDraft = TodayPlan.omit({ review_session_proposal: true }).extend({
  review_session_proposal: CoachReviewBriefDraft.default({
    knowledge_focus: [],
    intent_tags: [],
  }),
});
export type CoachPlanDraftT = z.infer<typeof CoachPlanDraft>;

export const COACH_MAX_PLAN_ADJUSTMENTS = 8;
export const COACH_MAX_MAINTENANCE_PROPOSALS = 8;

/** Attach the code-computed review numbers to the model's draft. */
export function composeTodayPlan(draft: CoachPlanDraftT, numbers: ReviewPlanNumbers): TodayPlanT {
  return TodayPlan.parse({
    ...draft,
    // The model's prose must not restate plan arithmetic.
    daily_focus: guardDailyFocusClaims(draft.daily_focus),
    review_session_proposal: {
      ...draft.review_session_proposal,
      count: numbers.count,
      estimated_minutes: numbers.estimated_minutes,
      subject_mix: numbers.subject_mix,
      time_box_minutes: numbers.time_box_minutes,
    },
  });
}

/**
 * Parse a `TodayPlan` JSON value. Returns the parsed plan on success or
 * throws on failure with a Zod error. Callers in the cron handler should
 * surface failures via `outcome='failure'` event with `error_reason`.
 */
export function parseTodayPlan(input: unknown): TodayPlanT {
  return TodayPlan.parse(input);
}
