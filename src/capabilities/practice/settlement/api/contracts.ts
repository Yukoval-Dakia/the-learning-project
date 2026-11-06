import { z } from 'zod';

export const CreateAppealBodySchema = z.union([
  z
    .object({
      evaluation_id: z.string().min(1),
      reason_md: z.string().max(2000).optional(),
      idempotency_key: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      judge_event_id: z.string().min(1),
      reason_md: z.string().max(2000).optional(),
    })
    .strict(),
]);

export const AppealResponseSchema = z.object({ appeal_event_id: z.string() });

export const AppealStatusParamsSchema = z.object({ id: z.string().min(1) });

const AppealVerdictSchema = z.object({
  coarse_outcome: z.string(),
  score: z.number().nullable(),
  feedback_md: z.string().nullable(),
});

/**
 * Learner-safe appeal/rejudge status (YUK-1880). `before`/`after` come from the
 * same evaluation→judge-result projection as `state.settled`; `after` exists only
 * once the rejudge produced a candidate, and names the live head in
 * `effective_evaluation_id` so unjudgeable/failed outcomes still show what stays
 * in force.
 */
export const AppealStatusResponseSchema = z.object({
  appeal_event_id: z.string(),
  status: z.enum(['in_progress', 'changed', 'unchanged', 'unjudgeable', 'failed']),
  evaluation_id: z.string(),
  evaluation_group_id: z.string().nullable(),
  reason_md: z.string(),
  submitted_at_sec: z.number(),
  before: AppealVerdictSchema.nullable(),
  after: AppealVerdictSchema.extend({ effective_evaluation_id: z.string().nullable() }).nullable(),
  /** Raw resolution disposition (`effective`, `review_required`, `stale_head`, …); null while unresolved. */
  disposition: z.string().nullable(),
});
