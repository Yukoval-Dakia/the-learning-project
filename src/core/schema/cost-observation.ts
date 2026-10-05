import { z } from 'zod';

export const CostBreakdownFields = {
  cost: z.number(),
  reported_cost: z.number(),
  estimated_cost: z.number(),
  legacy_cost: z.number(),
  // YUK-977 — basis-specific attempt counts carry the "amount is zero and the
  // source is known" truth at each aggregation grain (currency/task/day); a
  // zero reported_cost alone cannot distinguish "reported zero" from "no
  // reported rows".
  reported_attempts: z.number().int().nonnegative(),
  estimated_attempts: z.number().int().nonnegative(),
  unknown_attempts: z.number().int().nonnegative(),
  legacy_rows: z.number().int().nonnegative(),
};

export const CurrencyCostSchema = z.object({ currency: z.string(), ...CostBreakdownFields });

const Count = z.number().int().nonnegative();
const Quantity = z.number().nonnegative().nullable();
/** Aggregated accounting records, not an assertion about physical calls or subscription quota. */
export const ProviderCostDetailSchema = z.object({
  provider: z.string(),
  model: z.string().nullable(),
  lane_id: z.string().nullable(),
  task_kind: z.string(),
  source: z.enum(['provider_attempt', 'cost_ledger']),
  entry_kind: z.enum(['legacy', 'attempt']),
  cost_basis: z.enum(['reported', 'estimated', 'unknown']).nullable(),
  cost_ref: z.string().nullable(),
  currency: z.string(),
  amount: z.number().nullable(),
  records: Count,
  wire_calls: Quantity,
  unknown_wire_records: Count,
  usage_basis: z.enum(['reported', 'estimated', 'unknown', 'unclassified']),
  usage_unit: z.string().nullable(),
  usage_source: z.string().nullable(),
  usage_input: Quantity,
  usage_output: Quantity,
  usage_total: Quantity,
  missing_input_records: Count,
  missing_output_records: Count,
  missing_total_records: Count,
});
export const ProviderCostWindowSchema = z.object({
  scope: z.literal('all_activity'),
  records: Count,
  by_currency: z.array(CurrencyCostSchema),
  details: z.array(ProviderCostDetailSchema),
});
export type ProviderCostWindow = z.infer<typeof ProviderCostWindowSchema>;
export type ProviderCostDetail = z.infer<typeof ProviderCostDetailSchema>;
