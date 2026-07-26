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
// YUK-777 — liveness moved to server/judge-run-dispatch.ts so the reconcile sweeper asks the
// queue the exact same question this route does. Two copies of "is this run still going to
// progress?" would eventually disagree, and the two consumers would then disagree about
// whether a run needs recovering.
import {
  hasPendingAttemptEvidence,
  latestJudgeRecoveryJobId,
  resolveQueueLiveness,
} from '../server/judge-run-dispatch';
import { reconstructDoneFromDomainEvents } from '../server/judge-run-payload';
import {
  JUDGE_RUN_TABLE,
  JudgeRunTerminalResultSchema,
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
    const status = deriveJudgeRunStatus(events);

    // ── (1) A terminal job_event settles it ───────────────────────────────────────────
    // #12 — validate the terminal verdict through the response schema before serializing
    // (contract-shaped output, not a raw z.unknown()). safeParse: a malformed/legacy DONE
    // payload degrades to null rather than 500-ing the poll.
    if (status === 'done' || status === 'failed') {
      const rawResult = status === 'done' ? terminalJudgeRunResult(events) : null;
      const parsed = rawResult === null ? null : JudgeRunTerminalResultSchema.safeParse(rawResult);
      // #7 — the degrade is now OBSERVABLE. A DONE whose payload fails the contract used to
      // return `{status:'done', result:null}` silently, so a malformed/legacy terminal payload
      // in production was undiagnosable from the response alone. Log it server-side (the raw
      // payload never leaves the server) so the degradation shows up in the logs.
      if (parsed !== null && !parsed.success) {
        console.warn('[judge_run] terminal DONE payload failed the result contract', {
          run_id: runId,
          error: parsed.error.message,
        });
      }
      return Response.json({ run_id: runId, status, result: parsed?.success ? parsed.data : null });
    }

    // ── The run is NOT terminal in job_events. Is it still going to become one? ────────
    // W5 #TusVC — this liveness question applies to EVERY non-terminal run, not just the
    // marker-less ones. A run whose worker was hard-killed after writing STARTED, and whose
    // job then exhausted its retries into the DLQ, has a live-looking event trail and a dead
    // job; returning `started` forever told the client to poll a corpse. Asking the queue
    // first is also the cheap path: an in-flight run answers here with one PK lookup and
    // never touches the domain log.
    const pendingEvidence = await hasPendingAttemptEvidence(db, runId);
    const recoveryJobId = await latestJudgeRecoveryJobId(db, runId);
    const liveness = await resolveQueueLiveness(
      runId,
      recoveryJobId ? { jobId: recoveryJobId } : {},
    );
    if (liveness === 'live') {
      return Response.json({ run_id: runId, status, result: null });
    }
    if (liveness === 'unknown') {
      // pg-boss did not answer. Report what the events say and change nothing — a lookup
      // blip must never be upgraded into a verdict about the run.
      if (events.length === 0 && !pendingEvidence) {
        throw new ApiError('not_found', `judge_run ${runId} not found`, 404);
      }
      return Response.json({ run_id: runId, status, result: null });
    }

    // ── (2) The queue is done with this run. The DOMAIN log is the source of truth ─────
    // W5 #Tunn3 — per the design's `/status` contract (§3.6d): terminal job_event → DOMAIN
    // event by run_id → live queue → unknown. `job_events` is the progress stream, NOT the
    // source of truth: `prune_job_events` deletes it on a retention window and its terminal
    // write can fail outright. The permanent record is the review + judge event pair the
    // backfill tx commits, so a client returning after retention — or after a terminal write
    // that never landed — still learns its verdict (#Tunn2: the verdict never depended on
    // job_events to survive).
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

    // ── (3) Dead queue, nothing persisted ─────────────────────────────────────────────
    // #7 — with no events at all this is simply an unknown run_id; 200 `queued` would be a
    // fabrication. With events, the run demonstrably existed, was never judged, and can no
    // longer progress — `failed` is the honest terminal answer, and it stops the poll loop.
    // YUK-777 A2 — before declaring anything, ask whether the ANSWER was recorded. The submit
    // face now writes an immutable pending-attempt event before it dispatches, so a run whose
    // enqueue failed outright has no job and no job_events yet is perfectly real and will be
    // re-dispatched by `judge_pending_reconcile`. Both branches below would have lied about
    // it: 404 ("no such run") and `failed` ("this will never be judged").
    if (pendingEvidence) {
      return Response.json({ run_id: runId, status: 'queued' as const, result: null });
    }
    if (events.length === 0) {
      throw new ApiError('not_found', `judge_run ${runId} not found`, 404);
    }
    console.warn(
      `[judge_run] ${runId} is non-terminal in job_events but its queue job is dead, nothing persisted, and no pending attempt was recorded — reporting failed`,
    );
    return Response.json({ run_id: runId, status: 'failed' as const, result: null });
  } catch (err) {
    return errorResponse(err);
  }
}
