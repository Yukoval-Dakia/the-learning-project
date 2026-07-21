import { z } from 'zod';

import { ApiPageSchema } from '@/kernel/http-contracts';

export const AdminRunStatusSchema = z.enum(['running', 'success', 'failure']);

export const AdminRunsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().optional(),
  status: AdminRunStatusSchema.optional(),
  task_kind: z.string().optional(),
});

export const AdminRunParamsSchema = z.object({ id: z.string().min(1) });

/** These two readers intentionally preserve their legacy parseInt/default semantics. */
export const AdminCostQuerySchema = z.object({ days: z.string().optional() });
export const AdminFailuresQuerySchema = z.object({ limit: z.string().optional() });

export const AdminRunSchema = z.object({
  id: z.string(),
  task_kind: z.string(),
  provider: z.string(),
  model: z.string(),
  input_hash: z.string(),
  status: z.string(),
  finish_reason: z.string().nullable(),
  usage_json: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  cost_usd: z.number(),
  error_message: z.string().nullable(),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime().nullable(),
  duration_ms: z.number().nullable(),
  ledger_cost_usd: z.number(),
  ledger_rows: z.number().int().nonnegative(),
  tool_call_count: z.number().int().nonnegative(),
  pgboss_job_ids: z.array(z.string()),
});

export const AdminRunsResponseSchema = z.object({
  data: z.array(AdminRunSchema),
  page: ApiPageSchema,
  rows: z.array(AdminRunSchema),
  limit: z.number().int().positive(),
  next_cursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

const CostLedgerRowSchema = z.object({
  id: z.string(),
  task_run_id: z.string().nullable(),
  task_kind: z.string(),
  provider: z.string(),
  model: z.string(),
  cost: z.number(),
  currency: z.string(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  outcome: z.string(),
  pgboss_job_id: z.string().nullable(),
  occurred_at: z.string().datetime(),
});

const ToolCallRowSchema = z.object({
  id: z.string(),
  task_run_id: z.string(),
  task_kind: z.string(),
  tool_name: z.string(),
  effect: z.string().nullable(),
  input_json: z.record(z.string(), z.unknown()).nullable(),
  output_json: z.record(z.string(), z.unknown()).nullable(),
  error_reason: z.string().nullable(),
  iteration: z.number().int(),
  latency_ms: z.number(),
  cost: z.number(),
  occurred_at: z.string().datetime(),
  mirrored_event_id: z.string().nullable(),
});

const AdminRunTimelineEventSchema = z.object({
  type: z.enum(['run_started', 'tool_call', 'cost_ledger', 'run_finished']),
  at: z.string().datetime(),
  label: z.string(),
  id: z.string().optional(),
  tool_name: z.string().optional(),
  iteration: z.number().int().optional(),
  latency_ms: z.number().optional(),
  cost: z.number().optional(),
  tokens_in: z.number().int().optional(),
  tokens_out: z.number().int().optional(),
  outcome: z.string().optional(),
  pgboss_job_id: z.string().nullable().optional(),
});

export const AdminRunDetailResponseSchema = z.object({
  run: AdminRunSchema,
  ledger: z.array(CostLedgerRowSchema),
  tool_calls: z.array(ToolCallRowSchema),
  timeline: z.array(AdminRunTimelineEventSchema),
});

const AdminCostRowFields = {
  currency: z.string(),
  cost: z.number(),
  tokens_in: z.number().int(),
  tokens_out: z.number().int(),
  calls: z.number().int().nonnegative(),
};

export const AdminCostResponseSchema = z.object({
  days_window: z.number().int().positive(),
  days: z.array(z.object({ day: z.string(), ...AdminCostRowFields })),
  by_task: z.array(z.object({ task_kind: z.string(), ...AdminCostRowFields })),
});

const AdminFailureSampleSchema = z.object({
  id: z.string(),
  task_kind: z.string(),
  model: z.string(),
  started_at: z.string().datetime(),
  error_message: z.string().nullable(),
});

const AdminFailureClusterSchema = z.object({
  key: z.string(),
  finish_reason: z.string(),
  error_prefix: z.string(),
  count: z.number().int().positive(),
  latest_at: z.string().datetime(),
  samples: z.array(AdminFailureSampleSchema),
});

export const AdminFailuresResponseSchema = z.object({
  clusters: z.array(AdminFailureClusterSchema),
  limit: z.number().int().positive().max(200),
});

const CurrencyCostSchema = z.object({ currency: z.string(), cost: z.number() });

export const CostTodayResponseSchema = z.object({
  window: z.object({
    from: z.number().int(),
    to: z.number().int(),
    label: z.string(),
  }),
  today: z.object({
    by_currency: z.array(CurrencyCostSchema),
    tokens_in: z.number().int(),
    tokens_out: z.number().int(),
    ledger_rows: z.number().int().nonnegative(),
    tool_calls: z.number().int().nonnegative(),
    by_task: z.array(
      z.object({
        task_kind: z.string(),
        calls: z.number().int().nonnegative(),
        by_currency: z.array(CurrencyCostSchema),
      }),
    ),
  }),
});

// YUK-384 — durable hub-sync reconciler health (GET /api/admin/hub-sync).
export const HubSyncHealthResponseSchema = z.object({
  by_status: z.object({
    pending: z.number().int().nonnegative(),
    claimed: z.number().int().nonnegative(),
    applying: z.number().int().nonnegative(),
    retry_wait: z.number().int().nonnegative(),
    acknowledged: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
  }),
  dirty_count: z.number().int().nonnegative(),
  ready_count: z.number().int().nonnegative(),
  expired_lease_count: z.number().int().nonnegative(),
  invalid_document_count: z.number().int().nonnegative(),
  oldest_dirty_age_seconds: z.number().nullable(),
  oldest_invalid_age_seconds: z.number().nullable(),
  max_consecutive_failure_count: z.number().int().nonnegative(),
  max_generation_lag: z.string(),
  last_acknowledged_at: z.string().nullable(),
  last_repair_key: z.string().nullable(),
});
