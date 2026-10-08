import { gte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { tool_call_log } from '@/db/schema';
import type { CostTodayResponseSchema } from '../api/admin-observability-contracts';
import {
  type ProviderCostAggregateRow,
  readProviderCostAggregates,
} from './provider-cost-projection';

export type TodayCost = z.infer<typeof CostTodayResponseSchema>;

type CurrencyAggregate = TodayCost['today']['by_currency'][number];

function bjtMidnightUtc(now: Date): Date {
  // BJT = UTC+8. Find the most recent BJT midnight and project back to UTC.
  const bjt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const bjtMidnight = new Date(
    Date.UTC(bjt.getUTCFullYear(), bjt.getUTCMonth(), bjt.getUTCDate(), 0, 0, 0),
  );
  return new Date(bjtMidnight.getTime() - 8 * 60 * 60 * 1000);
}

/** Read today's existing cost projection using the caller's database and one clock sample. */
export async function loadTodayCost(db: Db | Tx, now: Date = new Date()): Promise<TodayCost> {
  const from = bjtMidnightUtc(now);
  const aggregates = await readProviderCostAggregates(db, from);

  const toolCallsCount = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tool_call_log)
    .where(gte(tool_call_log.occurred_at, from));

  const total = aggregates.find((row) => row.dimension === 'total');
  const costBreakdown = (row: ProviderCostAggregateRow) => ({
    cost: row.cost,
    reported_cost: row.reported_cost,
    estimated_cost: row.estimated_cost,
    legacy_cost: row.legacy_cost,
    reported_attempts: row.reported_attempts,
    estimated_attempts: row.estimated_attempts,
    unknown_attempts: row.unknown_attempts,
    legacy_rows: row.legacy_rows,
  });
  const byCurrency = aggregates.flatMap((row) =>
    row.dimension === 'currency' && row.currency !== null
      ? [{ currency: row.currency, ...costBreakdown(row) }]
      : [],
  );
  const byTruth = aggregates.flatMap((row) =>
    row.dimension === 'truth' && row.currency !== null && row.entry_kind !== null
      ? [
          {
            currency: row.currency,
            entry_kind: row.entry_kind,
            cost_basis: row.cost_basis,
            cost_ref: row.cost_ref,
            cost: row.cost,
            tokens_in: row.tokens_in,
            tokens_out: row.tokens_out,
            calls: row.calls,
            unknown_attempts: row.unknown_attempts,
          },
        ]
      : [],
  );
  const taskBuckets = new Map<
    string,
    { readonly task_kind: string; calls: number; readonly by_currency: CurrencyAggregate[] }
  >();
  for (const row of aggregates) {
    if (row.dimension !== 'task' || row.task_kind === null || row.currency === null) continue;
    const bucket = taskBuckets.get(row.task_kind) ?? {
      task_kind: row.task_kind,
      calls: 0,
      by_currency: [],
    };
    bucket.calls += row.calls;
    bucket.by_currency.push({ currency: row.currency, ...costBreakdown(row) });
    taskBuckets.set(row.task_kind, bucket);
  }

  return {
    window: {
      from: Math.floor(from.getTime() / 1000),
      to: Math.floor(now.getTime() / 1000),
      label: 'BJT today (from local midnight)',
    },
    today: {
      // YUK-330: per-currency amount key is `cost` (unified with /api/_/admin/cost
      // and the cost_ledger.cost source column). cost-today previously emitted
      // `spend`, diverging from admin-cost's `cost` for the same concept.
      by_currency: byCurrency,
      tokens_in: total?.tokens_in ?? 0,
      tokens_out: total?.tokens_out ?? 0,
      ledger_rows: total?.calls ?? 0,
      unknown_attempts: total?.unknown_attempts ?? 0,
      legacy_rows: total?.legacy_rows ?? 0,
      tool_calls: toolCallsCount[0]?.n ?? 0,
      by_truth: byTruth,
      by_task: [...taskBuckets.values()],
    },
  };
}
