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
import { reconstructDoneFromDomainEvents } from '../server/judge-run-payload';
import {
  JUDGE_RUN_TABLE,
  JudgeRunTerminalResultSchema,
  deriveJudgeRunStatus,
  terminalJudgeRunResult,
} from '../server/judge-run-status';

/**
 * pg-boss states from which a job can still run, and therefore still produce job_events.
 *
 * W5 #TumMo — existence is NOT the question; LIVENESS is. `getJobById` returns a row for
 * terminal states too (`completed` / `failed` / `cancelled`, and notably `expired` when a
 * prolonged worker outage meant the job was never picked up). Reporting `queued` for any of
 * those tells the client to keep polling a job that will never emit another event — exactly
 * the infinite-pending trap the 404 branch exists to prevent. Mirrors `orchestrator.ts`,
 * which also inspects `state` rather than mere existence.
 */
const LIVE_BOSS_STATES: ReadonlySet<string> = new Set(['created', 'retry', 'active']);

/**
 * W4 #TtWiD — is `runId` a real, still-RUNNABLE judge_run that simply has no job_events yet?
 *
 * `enqueueDurableJudge` pins the pg-boss job id to the run handle (`{ id: runId }`), so this
 * is a direct primary-key lookup, not a scan. Only consulted when the event trail is empty.
 *
 * Fails CLOSED to `false`: if pg-boss is unreachable we cannot assert the run is live, and a
 * 404 (the pre-existing behaviour) is a safer answer than a fabricated `queued`.
 */
async function durableJobIsLive(runId: string): Promise<boolean> {
  try {
    const boss = await getStartedBoss();
    const job = await boss.getJobById(JUDGE_RUN_QUEUE, runId);
    if (job === null) return false;
    const state = (job as { state?: string }).state;
    if (typeof state === 'string' && LIVE_BOSS_STATES.has(state)) return true;
    // A terminal job with no job_events at all: the run really did exist, but nothing will
    // ever finish it (typically `expired` after a long worker outage). Log it and fall
    // through to 404 — pretending it is queued would hang the client forever.
    console.warn(
      `[judge_run] ${runId} has no job_events and its pg-boss job is not live (state=${String(state)}) — reporting not-found`,
    );
    return false;
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
    // pg-boss directly before declaring the run unknown — and require the job to still be
    // RUNNABLE, since a terminal/expired job will never emit an event either (#TumMo).
    // W5 #Tunn3 — resolution order per the design's `/status` contract (§3.6d):
    //   (1) terminal job_event  →  (2) DOMAIN event by run_id  →  (3) live queue  →  (4) 404.
    // `job_events` is the progress stream, NOT the source of truth: `prune_job_events` deletes
    // it on a retention window and its terminal write can fail outright. The permanent record
    // is the review + judge event pair the backfill tx commits. Without step (2) a client that
    // came back after retention — or after a terminal write that never landed — got a 404 for
    // a run whose verdict is sitting durably in the domain log. This also means a run whose
    // terminal job_event was lost for good is still recoverable (#Tunn2), since the verdict
    // never depended on job_events to survive.
    if (events.length === 0) {
      const reconstructed = await reconstructDoneFromDomainEvents(db, runId);
      if (reconstructed !== null) {
        const parsedDomain = JudgeRunTerminalResultSchema.safeParse(reconstructed);
        if (!parsedDomain.success) {
          console.warn('[judge_run] domain-event reconstruction failed the result contract', {
            run_id: runId,
            error: parsedDomain.error.message,
          });
        }
        return Response.json({
          run_id: runId,
          status: 'done' as const,
          result: parsedDomain.success ? parsedDomain.data : null,
        });
      }
      if (await durableJobIsLive(runId)) {
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
