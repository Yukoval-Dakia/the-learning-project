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
import type { JobWithMetadata } from 'pg-boss';
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
 * terminal states too, so reporting `queued` for one tells the client to keep polling a job
 * that will never emit another event — exactly the infinite-pending trap the 404 branch
 * exists to prevent. Mirrors `orchestrator.ts`, which also inspects `state` rather than mere
 * existence.
 *
 * pg-boss 12 types the field as `'created' | 'retry' | 'active' | 'completed' | 'cancelled' |
 * 'failed'` (types.d.ts `JobWithMetadata`). There is no separate `expired` state in v12: a job
 * the worker never picked up before its expire window lands in `failed`, which this set
 * already excludes. The three below are the only non-terminal ones.
 */
const LIVE_BOSS_STATES: ReadonlySet<JobWithMetadata['state']> = new Set([
  'created',
  'retry',
  'active',
] as const);

/**
 * Can this run still make progress on the queue?
 *
 * Deliberately TRI-state. A boolean would have to fold "pg-boss says this job is dead" together
 * with "pg-boss did not answer", and those demand opposite responses: the first lets us stop a
 * client polling a corpse, while the second must change nothing — declaring a genuinely
 * in-flight run failed because a lookup blipped would be a far worse lie than the stale
 * `started` it replaces.
 *
 * `enqueueDurableJudge` pins the pg-boss job id to the run handle (`{ id: runId }`), so this is
 * a direct primary-key lookup, not a scan.
 *
 * `dead` also covers a null row: pg-boss prunes completed jobs on its own retention, so an
 * absent job is either long-finished or long-gone — either way the queue will not advance it.
 */
type QueueLiveness = 'live' | 'dead' | 'unknown';

async function resolveQueueLiveness(runId: string): Promise<QueueLiveness> {
  try {
    const boss = await getStartedBoss();
    const job = await boss.getJobById(JUDGE_RUN_QUEUE, runId);
    if (job === null) return 'dead';
    // #TuwGt — no assertion needed: `getJobById` returns `JobWithMetadata | null`, whose
    // `state` is a typed union, so the compiler checks this membership test for us.
    const { state } = job;
    if (LIVE_BOSS_STATES.has(state)) return 'live';
    console.warn(
      `[judge_run] ${runId} pg-boss job is not live (state=${state}) — it will not progress further`,
    );
    return 'dead';
  } catch (err) {
    console.error('[judge_run] pg-boss lookup failed while resolving run liveness', runId, err);
    return 'unknown';
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
    const liveness = await resolveQueueLiveness(runId);
    if (liveness === 'live') {
      return Response.json({ run_id: runId, status, result: null });
    }
    if (liveness === 'unknown') {
      // pg-boss did not answer. Report what the events say and change nothing — a lookup
      // blip must never be upgraded into a verdict about the run.
      if (events.length === 0) {
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
    if (events.length === 0) {
      throw new ApiError('not_found', `judge_run ${runId} not found`, 404);
    }
    console.warn(
      `[judge_run] ${runId} is non-terminal in job_events but its queue job is dead and nothing persisted — reporting failed`,
    );
    return Response.json({ run_id: runId, status: 'failed' as const, result: null });
  } catch (err) {
    return errorResponse(err);
  }
}
