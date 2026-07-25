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
import { getStartedBoss } from '@/server/boss/client';
import { computeReplay } from '@/server/events/sse_replay';
import { JUDGE_RUN_QUEUE } from '../server/judge-durable-config';
import {
  JUDGE_RUN_TABLE,
  JudgeRunTerminalResultSchema,
  deriveJudgeRunStatus,
  terminalJudgeRunResult,
} from '../server/judge-run-status';

/**
 * W4 #TtWiD — is `runId` a real, still-enqueued judge_run that simply has no job_events yet?
 *
 * `enqueueDurableJudge` pins the pg-boss job id to the run handle (`{ id: runId }`), so this
 * is a direct primary-key lookup, not a scan. Only consulted when the event trail is empty.
 *
 * Fails CLOSED to `false`: if pg-boss is unreachable we cannot assert the run exists, and a
 * 404 (the pre-existing behaviour) is a safer answer than a fabricated `queued`.
 */
async function durableJobExists(runId: string): Promise<boolean> {
  try {
    const boss = await getStartedBoss();
    return (await boss.getJobById(JUDGE_RUN_QUEUE, runId)) !== null;
  } catch (err) {
    console.error(
      '[judge_run] pg-boss lookup failed while resolving a marker-less run',
      runId,
      err,
    );
    return false;
  }
}

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
    //
    // W4 #TtWiD — but "zero job_events" is NOT the same as "no such run". The queued marker
    // is written AFTER `boss.send` and is best-effort, so a transient DB blip on that write
    // leaves a genuinely-enqueued run with no events at all. If the worker is ALSO down (no
    // STARTED to heal it) the poll URL we just advertised in the 202 would 404 — reporting
    // "does not exist" for a real run, in exactly the worker-outage scenario the durable lane
    // exists to cover. The run_id IS the pg-boss job id (`SendOptions.id` at enqueue), so ask
    // pg-boss directly before declaring the run unknown.
    if (events.length === 0) {
      if (await durableJobExists(runId)) {
        return Response.json({ run_id: runId, status: 'queued' as const, result: null });
      }
      throw new ApiError('not_found', `judge_run ${runId} not found`, 404);
    }
    const status = deriveJudgeRunStatus(events);
    // #12 — validate the terminal verdict through the response schema before serializing
    // (contract-shaped output, not a raw z.unknown()). safeParse: a malformed/legacy DONE
    // payload degrades to null rather than 500-ing the poll.
    const rawResult = status === 'done' ? terminalJudgeRunResult(events) : null;
    const parsed = rawResult === null ? null : JudgeRunTerminalResultSchema.safeParse(rawResult);
    // #7 — the degrade is now OBSERVABLE. A DONE whose payload fails the contract used to
    // return `{status:'done', result:null}` silently, so a malformed/legacy terminal payload
    // in production was undiagnosable from the response alone. Log it server-side (the raw
    // payload never leaves the server) so the degradation shows up in the logs.
    if (parsed && !parsed.success) {
      console.warn('[judge_run] terminal DONE payload failed the result contract', {
        run_id: runId,
        error: parsed.error.message,
      });
    }
    const result = parsed?.success ? parsed.data : null;
    return Response.json({ run_id: runId, status, result });
  } catch (err) {
    return errorResponse(err);
  }
}
