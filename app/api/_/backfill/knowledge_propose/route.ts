import { db } from '@/db/client';
import { runKnowledgeProposeNightly } from '@/server/boss/handlers/knowledge_propose_nightly';
import { errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

/**
 * Manual backfill endpoint —— 同步触发 knowledge_propose_nightly handler。
 * 用于历史数据补跑 / cron 失败重跑。
 *
 * 不接 query 参数（plan 写 since=<date> 但目前 handler 用固定 24h 窗口；如要
 * 自定义时间窗，未来给 handler 加 cutoff 参数）。
 */
export async function POST(_req: Request): Promise<Response> {
  try {
    const result = await runKnowledgeProposeNightly(db);
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
