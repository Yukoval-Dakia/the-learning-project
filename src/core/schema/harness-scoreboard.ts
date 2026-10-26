import { z } from 'zod';

/**
 * The deterministic harness scoreboard payload.
 *
 * Values are computed from raw rows, never hand-entered. M1/M2/M6 report one
 * number. M3/M4/M5 are lists of `parts`: each part owns its own
 * numerator/denominator and `basis`. `measured` means the raw table exposes the
 * exact quantity; `proxy` means the closest available raw signal, with the note
 * naming the difference; `unavailable` means the source table cannot answer it
 * without a new writer.
 */
export const HARNESS_SCOREBOARD_VERSION = 2 as const;

export const HARNESS_SCOREBOARD_EVENT_ACTION = 'experimental:harness_scoreboard';

export const HarnessMetricBasis = z.enum(['measured', 'proxy', 'unavailable']);
export type HarnessMetricBasisT = z.infer<typeof HarnessMetricBasis>;

export const HarnessMetricRay = z.object({
  key: z.string(),
  value: z.number().nullable(),
  numerator: z.number(),
  denominator: z.number(),
});
export type HarnessMetricRayT = z.infer<typeof HarnessMetricRay>;

/**
 * One ADR sub-item. Ratios carry numerator/denominator; gauges (a count or an
 * age in days) leave both null and put the number in `value`.
 */
export const HarnessMetricPart = z.object({
  key: z.string(),
  value: z.number().nullable(),
  numerator: z.number().nullable(),
  denominator: z.number().nullable(),
  basis: HarnessMetricBasis,
  note: z.string(),
});
export type HarnessMetricPartT = z.infer<typeof HarnessMetricPart>;

export const HarnessScoreboardV2 = z.object({
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
    basis: HarnessMetricBasis,
    note: z.string(),
  }),
  m2_loop_runs: z.object({
    value: z.number(),
    threshold: z.number().int().positive(),
    by_task: z.array(HarnessMetricRay),
    basis: HarnessMetricBasis,
    note: z.string(),
  }),
  m3_dropped_paid_output: z.object({
    parts: z.array(HarnessMetricPart),
    basis: HarnessMetricBasis,
    note: z.string(),
  }),
  m4_inbox_backlog: z.object({
    parts: z.array(HarnessMetricPart),
    basis: HarnessMetricBasis,
    note: z.string(),
  }),
  m5_duplicate_rate: z.object({
    parts: z.array(HarnessMetricPart),
    basis: HarnessMetricBasis,
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
    basis: HarnessMetricBasis,
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
export type HarnessScoreboardV2T = z.infer<typeof HarnessScoreboardV2>;
