import { db } from '@/db/client';
import { createBoss } from '@/server/boss/client';
import { ApiError, errorResponse } from '@/server/http/errors';
import { enqueueExtraction } from '@/server/ingestion/session';

export const runtime = 'nodejs';

/**
 * POST /api/ingestion/[id]/extract
 *
 * 用户触发抽取 —— 把 ingestion session 从 `uploaded` 或 `failed` 推进到 `queued`，
 * pg-boss 投递 `tencent_ocr_extract` job。客户端然后开 SSE 监听
 * `/api/ingestion/[id]/events` 看进度。
 *
 * 实际抽取由 worker 进程的 tencent_ocr_extract handler 完成（Step 9）。
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: sessionId } = await params;
    if (!sessionId) {
      throw new ApiError('validation_error', 'session id is required', 400);
    }
    const boss = createBoss();
    // boss singleton 可能未 start —— 调用时 pg-boss send 会 lazy start
    // 但 web process 不应该负责 start；测试 worker / scripts/worker.ts 才 start。
    // boss.send 不依赖 worker，只写 pgboss.* 表，所以 web 可直接 send。
    const { jobId } = await enqueueExtraction({ db, boss, sessionId });
    return Response.json({ businessId: sessionId, jobId });
  } catch (err) {
    return errorResponse(err);
  }
}
