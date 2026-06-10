import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { Ingestion } from '@/server/session';

/**
 * POST /api/ingestion/[id]/extract
 *
 * 用户触发抽取 —— 把 ingestion session 从 `uploaded` 或 `failed` 推进到 `queued`，
 * pg-boss 投递 `tencent_ocr_extract` job。客户端然后开 SSE 监听
 * `/api/ingestion/[id]/events` 看进度。
 *
 * 实际抽取由 worker 进程的 tencent_ocr_extract handler 完成（Step 9）。
 */
export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const sessionId = params.id;
    if (!sessionId) {
      throw new ApiError('validation_error', 'session id is required', 400);
    }
    // pg-boss v12 requires start() before send() (it throws "Database not
    // opened" otherwise). App processes enqueue via the started singleton
    // (getStartedBoss); the worker owns boss.work(). Using the unstarted
    // createBoss() here 500'd on the first enqueue in a cold app process (YUK-192).
    const boss = await getStartedBoss();
    const { jobId } = await Ingestion.enqueueExtraction({ db, boss, sessionId });
    return Response.json({ businessId: sessionId, jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
