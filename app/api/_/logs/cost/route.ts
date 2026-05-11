import { db } from '@/db/client';
import { cost_ledger } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';
import { sql } from 'drizzle-orm';

type CostRange = 'day' | 'week' | 'month';

function bucketExpr(range: CostRange): ReturnType<typeof sql> {
  switch (range) {
    case 'day':
      return sql`date_trunc('day', ${cost_ledger.occurred_at})::date::text`;
    case 'week':
      return sql`to_char(date_trunc('week', ${cost_ledger.occurred_at}), 'IYYY-"W"IW')`;
    case 'month':
      return sql`to_char(date_trunc('month', ${cost_ledger.occurred_at}), 'YYYY-MM')`;
  }
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rangeParam = url.searchParams.get('range') ?? 'day';
    if (rangeParam !== 'day' && rangeParam !== 'week' && rangeParam !== 'month') {
      return Response.json(
        { error: 'invalid_range', allowed: ['day', 'week', 'month'] },
        { status: 400 },
      );
    }
    const range: CostRange = rangeParam;

    const bucket = bucketExpr(range);

    const items = await db
      .select({
        bucket: bucket.as('bucket'),
        task_kind: cost_ledger.task_kind,
        model: cost_ledger.model,
        cost_sum: sql<number>`sum(${cost_ledger.cost})`.as('cost_sum'),
        tokens_in_sum: sql<number>`sum(${cost_ledger.tokens_in})`.as('tokens_in_sum'),
        tokens_out_sum: sql<number>`sum(${cost_ledger.tokens_out})`.as('tokens_out_sum'),
        call_count: sql<number>`count(*)::int`.as('call_count'),
      })
      .from(cost_ledger)
      .groupBy(bucket, cost_ledger.task_kind, cost_ledger.model)
      .orderBy(sql`1 desc`, sql`sum(${cost_ledger.cost}) desc`)
      .limit(200);

    return Response.json({ items, range });
  } catch (err) {
    return errorResponse(err);
  }
}
