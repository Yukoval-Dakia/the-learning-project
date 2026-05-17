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
//     today: { spend, tokens_in, tokens_out, ledger_rows, tool_calls, by_task }
//   }

import { desc, gte, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { cost_ledger, tool_call_log } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

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

    let spend = 0;
    let tokens_in = 0;
    let tokens_out = 0;
    const by_task = new Map<string, { spend: number; calls: number }>();
    for (const r of ledgerRows) {
      spend += r.cost;
      tokens_in += r.tokens_in;
      tokens_out += r.tokens_out;
      const cur = by_task.get(r.task_kind) ?? { spend: 0, calls: 0 };
      cur.spend += r.cost;
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
        spend,
        tokens_in,
        tokens_out,
        ledger_rows: ledgerRows.length,
        tool_calls: toolCallsCount[0]?.n ?? 0,
        by_task: [...by_task.entries()].map(([k, v]) => ({ task_kind: k, ...v })),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
