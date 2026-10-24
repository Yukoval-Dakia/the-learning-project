import { z } from 'zod';

/**
 * The deterministic harness scoreboard payload.
 *
 * Values are computed from raw rows, never hand-entered. `basis` is part of the
 * contract: `measured` means the raw table exposes the exact quantity; `proxy`
 * means the scoreboard uses the closest available raw signal and the note names
 * the difference; `unavailable` means the source table cannot answer it without a
 * new writer.
 */
export const HARNESS_SCOREBOARD_VERSION = 1 as const;

export const HarnessMetricRay = z.object({
  key: z.string(),
  value: z.number().nullable(),
  numerator: z.number(),
  denominator: z.number(),
});
export type HarnessMetricRayT = z.infer<typeof HarnessMetricRay>;

export const HarnessScoreboardV1 = z.object({
  version: z.literal(HARNESS_SCOREBOARD_VERSION),
  generated_at: z.string().datetime({ offset: true }),
  window: z.object({
    from_day: z.string(),
    to_day: z.string(),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
  }),
  m1_zero_yield_token_share: z.object({
    value: z.number().nullable(),
    failed_input_tokens: z.number(),
    total_input_tokens: z.number(),
    by_task: z.array(HarnessMetricRay),
    basis: z.enum(['measured', 'proxy', 'unavailable']),
    note: z.string(),
  }),
  m2_loop_runs: z.object({
    value: z.number(),
    threshold: z.number().int().positive(),
    by_task: z.array(HarnessMetricRay),
    basis: z.enum(['measured', 'proxy', 'unavailable']),
    note: z.string(),
  }),
  m3_dropped_paid_output: z.object({
    by_task: z.array(HarnessMetricRay),
    verifier_rejections: z.array(
      z.object({
        action: z.string(),
        total: z.number(),
        failed: z.number(),
        ratio: z.number().nullable(),
      }),
    ),
    basis: z.enum(['measured', 'proxy', 'unavailable']),
    note: z.string(),
  }),
  m4_inbox_backlog: z.object({
    pending: z.number(),
    oldest_pending_age_days: z.number().nullable(),
    proposed_in_window: z.number(),
    decided_in_window: z.number(),
    basis: z.enum(['measured', 'proxy', 'unavailable']),
    note: z.string(),
  }),
  m5_duplicate_rate: z.object({
    new_questions: z.number(),
    exact_duplicates: z.number(),
    duplicate_ratio: z.number().nullable(),
    same_name_knowledge_pairs: z.number(),
    basis: z.enum(['measured', 'proxy', 'unavailable']),
    note: z.string(),
  }),
  m6_idle_spend: z.object({
    currency: z.literal('USD'),
    daily: z.array(
      z.object({
        day: z.string(),
        user_events: z.number(),
        cost_usd: z.number(),
        input_tokens: z.number(),
      }),
    ),
    idle_days: z.number(),
    idle_daily_avg_usd: z.number().nullable(),
    active_daily_avg_usd: z.number().nullable(),
    basis: z.enum(['measured', 'proxy', 'unavailable']),
    note: z.string(),
  }),
  health: z.object({
    checked_at: z.string().datetime({ offset: true }),
    terminal_runs: z.number(),
    runs_missing_usage_fields: z.number(),
    duplicate_tool_call_rows: z.number(),
    exa_tool_call_rows: z.number(),
    failed_runs: z.number(),
    failed_runs_null_cost: z.number(),
  }),
});
export type HarnessScoreboardV1T = z.infer<typeof HarnessScoreboardV1>;

export const HARNESS_SCOREBOARD_EVENT_ACTION = 'experimental:harness_scoreboard';
