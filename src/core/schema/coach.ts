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

export const ReviewSessionProposal = z.object({
  count: z.number().int().nonnegative(),
  estimated_minutes: z.number().int().nonnegative(),
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

export const TodayPlan = z.object({
  daily_focus: z.string().min(1).max(280),
  review_session_proposal: ReviewSessionProposal,
  at_most_one_new_item: AtMostOneNewItem.optional(),
  // Only set when the plan is produced by `coach_weekly`.
  weekly_reflection: z.string().min(1).max(1200).optional(),
  plan_adjustments: z.array(PlanAdjustment).max(8),
  maintenance_proposals: z.array(MaintenanceProposal).max(8),
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
