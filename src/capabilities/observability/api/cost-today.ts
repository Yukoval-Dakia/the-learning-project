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
import { errorResponse } from '@/server/http/errors';

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
    const by_currency = new Map<string, number>();
    // by_task spend is also per-currency: key = `${task_kind}` → { currency → spend }.
    const by_task = new Map<string, { spend: Map<string, number>; calls: number }>();
    for (const r of ledgerRows) {
      tokens_in += r.tokens_in;
      tokens_out += r.tokens_out;
      by_currency.set(r.currency, (by_currency.get(r.currency) ?? 0) + r.cost);
      const cur = by_task.get(r.task_kind) ?? { spend: new Map<string, number>(), calls: 0 };
      cur.spend.set(r.currency, (cur.spend.get(r.currency) ?? 0) + r.cost);
      cur.calls += 1;
      by_task.set(r.task_kind, cur);
    }

    return Response.json({
      window: {
        from: Math.floor(from.getTime() / 1000),
        to: Math.floor(now.getTime() / 1000),
        label: 'BJT today (from local midnight)',
      },
      today: {
        by_currency: [...by_currency.entries()].map(([currency, spend]) => ({ currency, spend })),
        tokens_in,
        tokens_out,
        ledger_rows: ledgerRows.length,
        tool_calls: toolCallsCount[0]?.n ?? 0,
        by_task: [...by_task.entries()].map(([k, v]) => ({
          task_kind: k,
          calls: v.calls,
          by_currency: [...v.spend.entries()].map(([currency, spend]) => ({ currency, spend })),
        })),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
