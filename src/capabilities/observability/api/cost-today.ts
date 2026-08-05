// Phase 1d — daily cost summary for the /today cost ribbon.
//
// `/api/_/*` is excluded from the production build (Next.js treats a leading
// underscore as a private folder), so the existing /api/_/logs/cost endpoint
// can't power the UI. This is a parallel, non-private path scoped to the
// "today's spend" widget on /today.
//
// Returns:
//   {
//     window: { from, to, label }   — BJT (UTC+8) midnight → now
//     today: { by_currency, tokens_in, tokens_out, ledger_rows, tool_calls, by_task }
//   }
//
// YUK-359: spend is grouped by currency (USD = mimo/runner, CNY = GLM-OCR /
// memory reconcile). NEVER a single cross-currency sum — `cost_ledger.cost` holds
// raw values in the row's `currency`; summing USD + CNY would be meaningless.

import { desc, gte, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { cost_ledger, tool_call_log } from '@/db/schema';
import { errorResponse } from '@/kernel/http';

function bjtMidnightUtc(now: Date = new Date()): Date {
  // BJT = UTC+8. Find the most recent BJT midnight and project back to UTC.
  const bjt = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const bjtMidnight = new Date(
    Date.UTC(bjt.getUTCFullYear(), bjt.getUTCMonth(), bjt.getUTCDate(), 0, 0, 0),
  );
  return new Date(bjtMidnight.getTime() - 8 * 60 * 60 * 1000);
}

export async function GET(_req: Request): Promise<Response> {
  try {
    const from = bjtMidnightUtc();
    const now = new Date();

    const ledgerRows = await db
      .select({
        task_kind: cost_ledger.task_kind,
        cost: cost_ledger.cost,
        currency: cost_ledger.currency,
        entry_kind: cost_ledger.entry_kind,
        cost_basis: cost_ledger.cost_basis,
        cost_ref: cost_ledger.cost_ref,
        tokens_in: cost_ledger.tokens_in,
        tokens_out: cost_ledger.tokens_out,
      })
      .from(cost_ledger)
      .where(gte(cost_ledger.occurred_at, from))
      .orderBy(desc(cost_ledger.occurred_at));

    const toolCallsCount = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tool_call_log)
      .where(gte(tool_call_log.occurred_at, from));

    let tokens_in = 0;
    let tokens_out = 0;
    // YUK-359: spend grouped by currency (never a cross-currency sum).
    type CostBucket = {
      cost: number;
      reported_cost: number;
      estimated_cost: number;
      legacy_cost: number;
      unknown_attempts: number;
      legacy_rows: number;
    };
    const emptyBucket = (): CostBucket => ({
      cost: 0,
      reported_cost: 0,
      estimated_cost: 0,
      legacy_cost: 0,
      unknown_attempts: 0,
      legacy_rows: 0,
    });
    const addCost = (bucket: CostBucket, row: (typeof ledgerRows)[number]): void => {
      if (row.cost !== null) bucket.cost += row.cost;
      if (row.cost_basis === 'reported' && row.cost !== null) bucket.reported_cost += row.cost;
      if (row.cost_basis === 'estimated' && row.cost !== null) bucket.estimated_cost += row.cost;
      if (row.entry_kind === 'legacy') {
        bucket.legacy_rows += 1;
        if (row.cost !== null) bucket.legacy_cost += row.cost;
      }
      if (row.entry_kind === 'attempt' && row.cost_basis === 'unknown') {
        bucket.unknown_attempts += 1;
      }
    };
    const by_currency = new Map<string, CostBucket>();
    type CostTruthBucket = {
      currency: string;
      entry_kind: 'legacy' | 'attempt';
      cost_basis: 'reported' | 'estimated' | 'unknown' | null;
      cost_ref: string | null;
      cost: number;
      tokens_in: number;
      tokens_out: number;
      calls: number;
      unknown_attempts: number;
    };
    const by_truth = new Map<string, CostTruthBucket>();
    // by_task spend is also per-currency: key = `${task_kind}` → { currency → spend }.
    const by_task = new Map<string, { spend: Map<string, CostBucket>; calls: number }>();
    let unknown_attempts = 0;
    let legacy_rows = 0;
    for (const r of ledgerRows) {
      tokens_in += r.tokens_in;
      tokens_out += r.tokens_out;
      const currencyBucket = by_currency.get(r.currency) ?? emptyBucket();
      addCost(currencyBucket, r);
      by_currency.set(r.currency, currencyBucket);
      const cur = by_task.get(r.task_kind) ?? {
        spend: new Map<string, CostBucket>(),
        calls: 0,
      };
      const taskCurrencyBucket = cur.spend.get(r.currency) ?? emptyBucket();
      addCost(taskCurrencyBucket, r);
      cur.spend.set(r.currency, taskCurrencyBucket);
      cur.calls += 1;
      by_task.set(r.task_kind, cur);
      if (r.entry_kind === 'attempt' && r.cost_basis === 'unknown') unknown_attempts += 1;
      if (r.entry_kind === 'legacy') legacy_rows += 1;
      const entryKind = r.entry_kind === 'attempt' ? 'attempt' : 'legacy';
      const costBasis =
        r.cost_basis === 'reported' || r.cost_basis === 'estimated' || r.cost_basis === 'unknown'
          ? r.cost_basis
          : null;
      const truthKey = JSON.stringify([r.currency, entryKind, costBasis, r.cost_ref]);
      const truthBucket = by_truth.get(truthKey) ?? {
        currency: r.currency,
        entry_kind: entryKind,
        cost_basis: costBasis,
        cost_ref: r.cost_ref,
        cost: 0,
        tokens_in: 0,
        tokens_out: 0,
        calls: 0,
        unknown_attempts: 0,
      };
      if (r.cost !== null) truthBucket.cost += r.cost;
      truthBucket.tokens_in += r.tokens_in;
      truthBucket.tokens_out += r.tokens_out;
      truthBucket.calls += 1;
      if (entryKind === 'attempt' && costBasis === 'unknown') {
        truthBucket.unknown_attempts += 1;
      }
      by_truth.set(truthKey, truthBucket);
    }

    return Response.json({
      window: {
        from: Math.floor(from.getTime() / 1000),
        to: Math.floor(now.getTime() / 1000),
        label: 'BJT today (from local midnight)',
      },
      today: {
        // YUK-330: per-currency amount key is `cost` (unified with /api/_/admin/cost
        // and the cost_ledger.cost source column). cost-today previously emitted
        // `spend`, diverging from admin-cost's `cost` for the same concept.
        by_currency: [...by_currency.entries()].map(([currency, bucket]) => ({
          currency,
          ...bucket,
        })),
        tokens_in,
        tokens_out,
        ledger_rows: ledgerRows.length,
        unknown_attempts,
        legacy_rows,
        tool_calls: toolCallsCount[0]?.n ?? 0,
        by_truth: [...by_truth.values()],
        by_task: [...by_task.entries()].map(([k, v]) => ({
          task_kind: k,
          calls: v.calls,
          by_currency: [...v.spend.entries()].map(([currency, bucket]) => ({
            currency,
            ...bucket,
          })),
        })),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
