import { desc, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { cost_ledger } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

/**
 * GET /api/_/logs/jobs?limit=20 —— pg-boss job 聚合视图。
 *
 * 按 pgboss_job_id 分组，返回每 job 的 attempt 数 / 总 cost / 最新 outcome /
 * 最近时间，按 MAX(occurred_at) DESC 排序。仅含 pgboss_job_id 非 NULL 的行。
 */
export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const limit = Math.min(Number.parseInt(url.searchParams.get('limit') ?? '20', 10), 100);

    const rows = await db
      .select({
        pgboss_job_id: cost_ledger.pgboss_job_id,
        task_kind: sql<string>`MAX(${cost_ledger.task_kind})`,
        attempts: sql<number>`COUNT(*)::int`,
        total_cost: sql<number>`COALESCE(SUM(${cost_ledger.cost}), 0)::real`,
        total_tokens_in: sql<number>`COALESCE(SUM(${cost_ledger.tokens_in}), 0)::int`,
        total_tokens_out: sql<number>`COALESCE(SUM(${cost_ledger.tokens_out}), 0)::int`,
        latest_outcome: sql<string>`(SELECT outcome FROM cost_ledger c2 WHERE c2.pgboss_job_id = ${cost_ledger.pgboss_job_id} ORDER BY c2.occurred_at DESC LIMIT 1)`,
        latest_at: sql<string>`MAX(${cost_ledger.occurred_at})`,
      })
      .from(cost_ledger)
      .where(sql`${cost_ledger.pgboss_job_id} IS NOT NULL`)
      .groupBy(cost_ledger.pgboss_job_id)
      .orderBy(desc(sql`MAX(${cost_ledger.occurred_at})`))
      .limit(limit);

    return Response.json({ jobs: rows });
  } catch (err) {
    return errorResponse(err);
  }
}
