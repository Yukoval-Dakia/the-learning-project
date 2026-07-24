// YUK-594 (durable judge main path, W1) — GET /api/jobs/judge_run/[id]/status。
//
// D2 三层回填的 poll tier（SSE 主 + poll fallback + replay）：拿不住 SSE 长连接的
// 客户端（移动后台 / 弱网）用它一次性拉 run 状态 + 终态判词。纯读 job_events
// replay → deriveJudgeRunStatus + terminalJudgeRunResult，无副作用。202-pending 契约
// 的 poll_url 指向它（submit.ts enqueueDurableJudge）。
//
// 与泛化 SSE `/api/jobs/[kind]/[id]/events`（observability，caller-agnostic）互补：
// SSE 是 live 主通道，本路由是快照 fallback。judge-scoped（practice 拥有 judge_run
// + deriveJudgeRunStatus），不引入通用 per-kind reducer registry。

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { computeReplay } from '@/server/events/sse_replay';
import {
  JUDGE_RUN_TABLE,
  deriveJudgeRunStatus,
  terminalJudgeRunResult,
} from '../server/judge-run-status';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const runId = params.id;
    if (!runId) {
      throw new ApiError('validation_error', 'missing run id', 400);
    }
    const events = await computeReplay(db, {
      businessTable: JUDGE_RUN_TABLE,
      businessId: runId,
      lastEventId: 0,
    });
    // #7 — an unknown run_id has zero job_events. Reporting 200 `queued` for it is
    // dishonest (it implies a real run is pending). 404 instead: no such judge_run.
    if (events.length === 0) {
      throw new ApiError('not_found', `judge_run ${runId} not found`, 404);
    }
    const status = deriveJudgeRunStatus(events);
    const result = status === 'done' ? terminalJudgeRunResult(events) : null;
    return Response.json({ run_id: runId, status, result });
  } catch (err) {
    return errorResponse(err);
  }
}
