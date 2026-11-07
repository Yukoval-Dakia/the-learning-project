import { z } from 'zod';

export const TaskFailureAlertSchema = z.object({
  /** Deterministic alert id; equals the recorded event id once written. */
  id: z.string(),
  task_kind: z.string(),
  rule: z.enum(['consecutive', 'rate', 'unsealed', 'optional_dependency']),
  failures: z.number().int().nonnegative(),
  /** Terminal runs counted by the rule (consecutive: equals failures). */
  runs: z.number().int().nonnegative(),
  /** consecutive: first failure of the streak; rate: window start. */
  since: z.string().datetime(),
  last_failure_at: z.string().datetime(),
  /** consecutive: last success ever; rate: last success inside the window. */
  last_success_at: z.string().datetime().nullable(),
  /** Open in /admin/runs for the error detail. */
  latest_run_id: z.string(),
  latest_finish_reason: z.string().nullable(),
  /** optional_dependency only: which optional capability degraded. */
  dependency: z.literal('web_search').optional(),
  /** optional_dependency only: unknown causes count as network. */
  category: z.enum(['authorization', 'network']).optional(),
  /** optional_dependency only: learner copy; never names the provider or host. */
  learner_title: z.string().optional(),
  learner_detail: z.string().optional(),
  /** Null until the hourly job has written this episode's event. */
  recorded_event_id: z.string().nullable(),
  recorded_at: z.string().datetime().nullable(),
});

export const TaskFailureAlertsResponseSchema = z.object({
  checked_at: z.string().datetime(),
  thresholds: z.object({
    consecutive_failures: z.number().int(),
    window_hours: z.number().int(),
    failure_rate_above: z.number(),
    min_runs_in_window: z.number().int(),
    stale_after_days: z.number().int(),
  }),
  alerts: z.array(TaskFailureAlertSchema),
  /** Processes running without a required setting; names only, never values. */
  config_incomplete: z.array(
    z.object({
      process: z.enum(['api', 'worker']),
      missing: z.array(z.string()).min(1),
      seen_at: z.string().datetime(),
    }),
  ),
});
