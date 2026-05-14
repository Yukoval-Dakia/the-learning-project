import { asc, eq } from 'drizzle-orm';

import { db } from '@/db/client';
import { cost_ledger, tool_call_log } from '@/db/schema';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

/**
 * GET /api/_/logs/jobs/[id] —— 单 pg-boss job 详情：全部 attempts (cost_ledger
 * 行，按时间 ASC) + 关联 tool_call_log（若 task_run_id 落上）。
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: pgboss_job_id } = await params;

    const attempts = await db
      .select()
      .from(cost_ledger)
      .where(eq(cost_ledger.pgboss_job_id, pgboss_job_id))
      .orderBy(asc(cost_ledger.occurred_at));

    if (attempts.length === 0) {
      return Response.json({ error: 'not_found', message: `no job ${pgboss_job_id}` }, {
        status: 404,
      });
    }

    // pg-boss_job_id 与 task_run_id 解耦（不同概念），但若处于同一 task 内
    // tool_call_log 可按 task_kind / occurred_at 范围查
    const taskKind = attempts[0].task_kind;
    const tools = await db
      .select()
      .from(tool_call_log)
      .where(eq(tool_call_log.task_kind, taskKind))
      .orderBy(asc(tool_call_log.occurred_at))
      .limit(50);

    const summary = {
      pgboss_job_id,
      task_kind: taskKind,
      attempts: attempts.length,
      total_cost: attempts.reduce((s, a) => s + a.cost, 0),
      total_tokens_in: attempts.reduce((s, a) => s + a.tokens_in, 0),
      total_tokens_out: attempts.reduce((s, a) => s + a.tokens_out, 0),
      latest_outcome: attempts[attempts.length - 1].outcome,
    };

    return Response.json({ summary, attempts, tool_calls: tools });
  } catch (err) {
    return errorResponse(err);
  }
}
