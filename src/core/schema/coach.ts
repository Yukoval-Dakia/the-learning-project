// Wave 5 / T-D6 — Global Coach Orchestrator (Phase 3) result schema.
//
// `CoachTask` produces a `TodayPlan` JSON object that the `coach_daily` and
// `coach_weekly` pg-boss handlers translate into proposal-only mutations via
// the COACH allowlist surface. The shape is shared with the `/today` drawer
// summary endpoint so Coach output renders directly in the first-paint slot.

import { z } from 'zod';

export const PlanAdjustmentKind = z.enum(['defer', 'split', 'relearn', 'archive']);
export type PlanAdjustmentKindT = z.infer<typeof PlanAdjustmentKind>;

export const PlanAdjustment = z.object({
  kind: PlanAdjustmentKind,
  learning_item_id: z.string().min(1),
  reasoning: z.string().min(1).max(2000).optional(),
});
export type PlanAdjustmentT = z.infer<typeof PlanAdjustment>;

// YUK-203 U4 / D5 — strategic review brief. Coach grows the flat
// {count, estimated_minutes} proposal into the single attention prior handed
// down to ReviewPlanTask (CO §6:621-622, no new artifact type). ALL new fields
// are optional/defaulted so plans emitted before U4 (and re-parsed over the
// 25-event coach-scan window in getLatestCoachPlan / parseCoachOutputSafely)
// still parse unchanged. `count` / `estimated_minutes` stay required as today.
//
//   - knowledge_focus  — ranked knowledge_ids to prioritise (from due/weak +
//     active-item attention pressure, D11①). Empty = no prior; ReviewPlanTask
//     degrades to pure due-pressure.
//   - subject_mix      — relative attention weight per subject for the session.
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

export const AtMostOneNewItem = z.object({
  learning_item_id: z.string().min(1),
  title: z.string().min(1),
});
export type AtMostOneNewItemT = z.infer<typeof AtMostOneNewItem>;

export const MaintenanceProposal = z.object({
  kind: z.string().min(1),
  payload: z.unknown(),
});
export type MaintenanceProposalT = z.infer<typeof MaintenanceProposal>;

// YUK-143 / ADR-0025 — North-Star goal strand. One item = "today's goal-oriented
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
  // knowledge nodes this action touches (closes the no-knowledge_ids gap).
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
  // YUK-143 / ADR-0025 — active goals this plan addresses + the goal-oriented
  // strand. Both optional + default-empty so plans produced before North-Star
  // (or by a model that emits no goal strand) parse unchanged. ND-5: these are
  // additive direction tags only — the review backbone above is untouched.
  goal_ids: z.array(z.string().min(1)).default([]),
  goal_strand: z.array(GoalStrandItem).max(COACH_MAX_GOAL_STRAND_ITEMS).default([]),
});
export type TodayPlanT = z.infer<typeof TodayPlan>;

export const COACH_MAX_PLAN_ADJUSTMENTS = 8;
export const COACH_MAX_MAINTENANCE_PROPOSALS = 8;

/**
 * Parse a `TodayPlan` JSON value. Returns the parsed plan on success or
 * throws on failure with a Zod error. Callers in the cron handler should
 * surface failures via `outcome='failure'` event with `error_reason`.
 */
export function parseTodayPlan(input: unknown): TodayPlanT {
  return TodayPlan.parse(input);
}
