// M5-T3 (YUK-321) — POST /api/copilot/chat（SSE）。
// 等价平移 app/api/copilot/chat/route.ts：两 surface（chat | chip）路由契约、
// delta/reply 帧语义、parse-before-stream、错误串脱敏三件不变。
// 形态变更仅一处（M5 唯一运行时形态变更）：手工 ReadableStream → hono
// SSEStreamingApi 自构 Response（裁决 j：RouteHandler 是 Web 标准签名，不经
// hono Context，故不用 streamSSE(c)）。delta 回调是同步 (text)=>void、
// writeSSE 是 async —— promise chain 保 FIFO。

import { SSEStreamingApi } from 'hono/streaming';
import { ZodError } from 'zod';

// YUK-575 (N6/MF-C) — the pickup-timeout deadline stamped on the QUEUED event so a
// consumer (PR2 Dock, isDurablePickupStalled) can detect a worker-down stall.
import { PICKUP_TIMEOUT_MS } from '@/capabilities/copilot/durable-pickup';
import {
  CopilotChatRequest,
  decideCopilotDispatch,
  runCopilotChatStreaming,
  writeCopilotReply,
} from '@/capabilities/copilot/server/chat';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import {
  MAX_OUTSTANDING_DURABLE_RUNS,
  countOutstandingDurableRuns,
} from '@/capabilities/copilot/server/durable-backlog';
import {
  COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH,
  type CopilotDurableAcceptance,
  type ReserveCopilotDurableAcceptanceResult,
  findCopilotDurableAcceptance,
  hasTerminalCopilotRun,
  hashCopilotDurableInput,
  reconcileCopilotDurableAcceptance,
  reserveCopilotDurableAcceptance,
  withCopilotDurableDispatchLock,
} from '@/capabilities/copilot/server/durable-dispatch';
import { db } from '@/db/client';
import { ApiError, HTTP_PROVIDER_SESSION_BUDGET_MS, errorResponse } from '@/kernel/http';
import { getStartedBoss } from '@/server/boss/client';
import { writeJobEvent } from '@/server/events/writer';
import { checkRateLimit } from '@/server/http/rate-limit';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { Conversation } from '@/server/session';

// Closes the count-then-enqueue race inside the single Hono API process. A slot
// moves from this counter into durable job_events once QUEUED is committed.
let durableDispatchReservations = 0;

// Candidate prose stays buffered until YUK-832 review completes, so keep the
// Cloudflare Tunnel connection alive with an SSE comment rather than leaking an
// unreviewed delta. The heartbeat does not extend the request budget: dispatch,
// the primary run, blind reference and every comparator all share the single
// absolute provider-session deadline below.
export const COPILOT_INLINE_SSE_HEARTBEAT_MS = 15_000;
// One edge request can perform a bounded dispatch judgment and then an inline
// Copilot run. Admission wait, SDK startup and model execution must share this
// absolute budget so the retained synchronous path stays below cloudflared's
// 100s idle window instead of adding each phase's independent maximum.
export const COPILOT_INLINE_PROVIDER_SESSION_BUDGET_MS = HTTP_PROVIDER_SESSION_BUDGET_MS;

function requestAbortedError(): ApiError {
  // 499 is the conventional server-side status for a client-closed request.
  // The caller is already gone; the important contract is that no new durable
  // side effect is committed after this guard observes the abort.
  return new ApiError('request_aborted', 'request aborted before acceptance', 499);
}

function assertRequestActive(signal: AbortSignal): void {
  if (signal.aborted) throw requestAbortedError();
}

type ParsedCopilotChatRequest = ReturnType<typeof CopilotChatRequest.parse>;

class CopilotDispatchAmbiguousError extends ApiError {
  constructor(cause: unknown) {
    super(
      'copilot_enqueue_ambiguous',
      'durable run acceptance or queue state could not be confirmed; retry with the same Idempotency-Key',
      503,
      { 'Retry-After': '1' },
    );
    this.cause = cause;
  }
}

class CopilotDispatchNotAcceptedError extends Error {
  constructor(cause: unknown) {
    super('durable run could not be enqueued', { cause });
    this.name = 'CopilotDispatchNotAcceptedError';
  }
}

function durableAcceptanceResponse(acceptance: CopilotDurableAcceptance): Response {
  return Response.json(
    {
      run_id: acceptance.runId,
      session_id: acceptance.sessionId,
      checkpoint_event_id: acceptance.runId,
    },
    {
      status: 202,
      headers: {
        Location: `/api/jobs/copilot_run/${encodeURIComponent(acceptance.runId)}/events`,
      },
    },
  );
}

async function dispatchAcceptedRun(
  acceptance: CopilotDurableAcceptance,
  parsed: ParsedCopilotChatRequest,
): Promise<void> {
  try {
    const outcome = await withCopilotDurableDispatchLock(db, acceptance.runId, async (tx) => {
      // A terminal replay is still the same accepted operation. Never recreate a
      // deleted pg-boss row after its durable public result already exists.
      if (await hasTerminalCopilotRun(tx, acceptance.runId)) {
        return { status: 'settled' as const };
      }

      const boss = await getStartedBoss();
      try {
        if (await boss.getJobById('copilot_run', acceptance.bossJobId)) {
          return { status: 'accepted' as const };
        }
      } catch (readErr) {
        // We have not sent anything in this attempt, but an earlier ambiguous
        // attempt may already own this stable id. Do not write a false FAILED.
        throw new CopilotDispatchAmbiguousError(readErr);
      }

      try {
        await boss.send(
          'copilot_run',
          {
            run_id: acceptance.runId,
            session_id: acceptance.sessionId,
            user_message: parsed.user_message,
            triggered_by: parsed.triggered_by,
            ...(parsed.chip_kind ? { chip_kind: parsed.chip_kind } : {}),
            ...(parsed.ambient_context ? { ambient: parsed.ambient_context } : {}),
          },
          { id: acceptance.bossJobId },
        );
      } catch (sendErr) {
        // `send` may have committed and only lost its acknowledgement. Read back
        // the deterministic job id before deciding whether compensation is safe.
        try {
          if (await boss.getJobById('copilot_run', acceptance.bossJobId)) {
            return { status: 'accepted' as const };
          }
        } catch (readErr) {
          throw new CopilotDispatchAmbiguousError(readErr);
        }
        // A successful readback proving absence is the only path allowed to mark
        // this accepted turn enqueue_failed. The compensation MUST commit while
        // this same dispatch advisory lock is still held. Releasing the lock and
        // compensating in a second transaction would let a same-key contender
        // enqueue the stable job between those two critical sections, producing
        // a FAILED run whose worker is already executing.
        await writeJobEvent(tx, {
          business_table: COPILOT_RUN_TABLE,
          business_id: acceptance.runId,
          event_type: COPILOT_RUN_EVENTS.FAILED,
          payload: { reason: 'enqueue_failed', checkpoint_event_id: acceptance.runId },
        });
        await writeCopilotReply(tx, {
          sessionId: acceptance.sessionId,
          userAskEventId: acceptance.runId,
          replyText: 'run 未能受理（enqueue 失败）。请重试。',
          actorRef: 'agent:copilot',
          taskRunId: `copilot_run_enqueue_failed_${acceptance.runId}`,
          now: new Date(),
        });
        return { status: 'not_accepted' as const, cause: sendErr };
      }
      return { status: 'accepted' as const };
    });
    if (outcome.status === 'not_accepted') {
      throw new CopilotDispatchNotAcceptedError(outcome.cause);
    }
  } catch (err) {
    if (
      err instanceof CopilotDispatchAmbiguousError ||
      err instanceof CopilotDispatchNotAcceptedError
    ) {
      throw err;
    }
    // Includes advisory-lock/transaction settlement failures after a successful
    // send. Conservatively keep QUEUED; a same-key replay can disambiguate.
    throw new CopilotDispatchAmbiguousError(err);
  }
}

// 签名对齐 kernel RouteHandler 双参形（path 无参数段，_params 不用）。
export async function POST(req: Request, _params: Record<string, string>): Promise<Response> {
  const providerSessionDeadlineAt = Date.now() + COPILOT_INLINE_PROVIDER_SESSION_BUDGET_MS;
  // Parse BEFORE constructing the stream：坏 body 走普通 JSON error（既有契约），
  // 绝不开半截 SSE 流。
  let parsed: ReturnType<typeof CopilotChatRequest.parse>;
  try {
    parsed = CopilotChatRequest.parse(await req.json());
  } catch (err) {
    // M5-T3 plan 钉测：schema 校验失败 → 400 validation_error JSON（plan Task 2
    // 单测 + curl 冒烟双钉）。旧栈裸 errorResponse(ZodError) 实回 500 —— 计划与
    // 现实冲突处以计划为准，对齐 practice/accept-chip 的 validation_error 形制。
    if (err instanceof ZodError) {
      return errorResponse(
        new ApiError('validation_error', err.issues.map((i) => i.message).join('; '), 400),
      );
    }
    return errorResponse(err);
  }
  if (req.signal.aborted) return errorResponse(requestAbortedError());

  const idempotencyKey = req.headers.get('Idempotency-Key')?.trim() || undefined;
  if (idempotencyKey && idempotencyKey.length > COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH) {
    return errorResponse(
      new ApiError(
        'validation_error',
        `Idempotency-Key must be at most ${COPILOT_IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
        400,
      ),
    );
  }
  const durableInputHash = hashCopilotDurableInput(parsed);

  // Replay accepted durable work before backlog/rate-limit/model triage. A
  // client that lost the 202 must recover the original handle, not buy another
  // classifier call or be rejected by capacity consumed by its own run.
  if (idempotencyKey) {
    let accepted: CopilotDurableAcceptance | null = null;
    try {
      accepted = await findCopilotDurableAcceptance(db, idempotencyKey);
    } catch (findErr) {
      try {
        // A lost-202 recovery must never turn a transient read failure into a
        // generic 500 that tells the client to discard its stable key. Re-read
        // behind the reserve lock; this also waits out any in-flight COMMIT.
        accepted = await reconcileCopilotDurableAcceptance(db, idempotencyKey);
      } catch (reconcileErr) {
        return errorResponse(
          new CopilotDispatchAmbiguousError(
            new AggregateError(
              [findErr, reconcileErr],
              'durable replay lookup and locked reconciliation were both unavailable',
            ),
          ),
        );
      }
    }
    if (accepted && accepted.inputHash !== durableInputHash) {
      return errorResponse(
        new ApiError(
          'idempotency_conflict',
          `Idempotency-Key is already bound to durable run ${accepted.runId}`,
          409,
        ),
      );
    }
    if (accepted) {
      try {
        await dispatchAcceptedRun(accepted, parsed);
      } catch (err) {
        return errorResponse(err);
      }
      return durableAcceptanceResponse(accepted);
    }
  }

  const backgroundJobsEnabled = shouldEnqueueBackgroundJobs();
  const shouldClassifyDispatch =
    parsed.durable === undefined &&
    parsed.triggered_by === 'chat' &&
    !parsed.skill_context &&
    backgroundJobsEnabled;
  const shouldReserveDurableCapacity =
    parsed.triggered_by === 'chat' &&
    !parsed.skill_context &&
    backgroundJobsEnabled &&
    (parsed.durable === true || shouldClassifyDispatch);
  let preAcceptanceReservation = false;
  const releasePreAcceptanceReservation = () => {
    if (!preAcceptanceReservation) return;
    durableDispatchReservations--;
    preAcceptanceReservation = false;
  };
  let dispatchDecision: Awaited<ReturnType<typeof decideCopilotDispatch>> | undefined;
  try {
    if (shouldReserveDurableCapacity) {
      // A turn that may become durable reserves backlog capacity before any
      // paid model work. Automatic inline/error/abort releases it; automatic
      // durable transfers this exact reservation into acceptance.
      assertRequestActive(req.signal);
      const outstanding = await countOutstandingDurableRuns(db);
      assertRequestActive(req.signal);
      if (outstanding + durableDispatchReservations >= MAX_OUTSTANDING_DURABLE_RUNS) {
        throw new ApiError(
          'copilot_backlog_full',
          `durable Copilot backlog is full (max ${MAX_OUTSTANDING_DURABLE_RUNS})`,
          429,
          { 'Retry-After': '30' },
        );
      }
      durableDispatchReservations++;
      preAcceptanceReservation = true;
    }
    // Every schema-valid Copilot POST owns exactly one AI-funnel slot, including
    // force-inline/chip/skill turns. For automatic chat, that one slot covers
    // both the bounded classifier and the selected main run.
    checkRateLimit();
    if (shouldClassifyDispatch) {
      dispatchDecision = await decideCopilotDispatch(
        db,
        {
          user_message: parsed.user_message,
          ...(parsed.ambient_context ? { ambient_context: parsed.ambient_context } : {}),
        },
        { signal: req.signal, providerSessionDeadlineAt },
      );
    }
  } catch (err) {
    releasePreAcceptanceReservation();
    return errorResponse(err);
  }
  // The model judgment happens before the 200/202 acceptance boundary. If the
  // client disconnected while it was in flight, do not turn its now-ambiguous
  // failed POST into a paid durable run that a retry could duplicate.
  if (req.signal.aborted) {
    releasePreAcceptanceReservation();
    return errorResponse(requestAbortedError());
  }
  const durableRequested = parsed.durable === true || dispatchDecision?.mode === 'durable';
  if (!durableRequested) releasePreAcceptanceReservation();

  // YUK-364/YUK-757 — durable 分流。显式 durable:true 仍直接受理；未显式选择的
  // eligible free-form turn 先由 no-tool CopilotDispatchTask 做一次 bounded judgment。
  // durable:false 是 force-inline。这里只让 chat surface 入 durable 面；chip 与
  // skill_context 继续走确定性 inline 路径。
  //
  // YUK-575 (MF-C 诚实措辞) — shouldEnqueueBackgroundJobs()（runtime-env.ts）**只挡
  // 测试环境**（NODE_ENV==='test'||VITEST），**零 worker-liveness 检测**；生产恒 true，
  // 且 boss.send 只 INSERT job 行、无论有无 worker 消费都成功。故它 NOT 一个「worker
  // 可用」守卫——worker 挂/crash-loop/漏 RW_WORKER 时 run 会卡 QUEUED 无人拾取。PR1 的
  // pickup-stall 检测 = QUEUED 事件上盖 pickup_deadline_ms + isDurablePickupStalled
  // 纯谓词（durable-pickup.ts）；主动 surfacing（报错 / force-inline）随 Dock 消费端落
  // PR2（YUK-596）——不在 dispatch 阻塞 202 等 pickup（batchSize:1 串行下 busy worker
  // 会 false-timeout + 双结果，strictly worse）。
  //
  // YUK-364 (bot-review C3) — **排除带 skill_context 的 turn**（`!parsed.skill_context`）。
  // 一个 skill_context:{skill:'teaching'} turn 在 inline 路径短路到 runTeachingSkill
  // 物化 ask_check 结构化题（turn_kind / skill_turn / skill_context 落 reply payload，
  // 走确定性服务回复、不经 free-form 收敛点）。但 durable enqueue 只投
  // {run_id, session_id, user_message, triggered_by, chip_kind?} —— 丢了 skill_context，
  // worker handler 永远跑 free-form CopilotTask loop（无 teaching 短路）。若放任
  // durable teaching turn 入队，会丢失整个结构化教学协议（ask_check 物化、suggested_next
  // chips、corrective-chip 锚）。本 lane durable 暂不能复刻 teaching skill 短路（teaching
  // 是 SERVICE-层 behavior pack，不是 free-form run），故 skill_context turn 一律留 inline。
  if (
    durableRequested &&
    parsed.triggered_by === 'chat' &&
    !parsed.skill_context &&
    backgroundJobsEnabled
  ) {
    let acceptance: CopilotDurableAcceptance | undefined;
    let reservedDispatchSlot = preAcceptanceReservation;
    preAcceptanceReservation = false;
    try {
      assertRequestActive(req.signal);
      // YUK-693 — bound both a short request burst and the durable backlog. The
      // process-local reservation closes concurrent count→enqueue races; the DB
      // query remains the durable source of truth across restarts/processes.
      if (!reservedDispatchSlot) {
        const outstanding = await countOutstandingDurableRuns(db);
        assertRequestActive(req.signal);
        if (outstanding + durableDispatchReservations >= MAX_OUTSTANDING_DURABLE_RUNS) {
          throw new ApiError(
            'copilot_backlog_full',
            `durable Copilot backlog is full (max ${MAX_OUTSTANDING_DURABLE_RUNS})`,
            429,
            { 'Retry-After': '30' },
          );
        }
        durableDispatchReservations++;
        reservedDispatchSlot = true;
      }

      // 1) 复用 inline 同一会话信封——durable run 的 user_ask / 回复事件共享 session_id。
      const conv = await Conversation.findOrCreateCopilotConversation(db, {});
      assertRequestActive(req.signal);
      // 2) One transaction reserves the stable handle and commits user_ask +
      // QUEUED together. Same key + same normalized input reuses that handle;
      // a changed input is an explicit 409 rather than a second paid run.
      let reservation: ReserveCopilotDurableAcceptanceResult;
      try {
        reservation = await reserveCopilotDurableAcceptance(db, {
          sessionId: conv.sessionId,
          userMessage: parsed.user_message,
          inputHash: durableInputHash,
          ...(idempotencyKey ? { idempotencyKey } : {}),
          queuedPayload: {
            session_id: conv.sessionId,
            triggered_by: parsed.triggered_by,
            pickup_deadline_ms: Date.now() + PICKUP_TIMEOUT_MS,
            dispatch:
              dispatchDecision?.mode === 'durable'
                ? {
                    source: dispatchDecision.source,
                    reason_code: dispatchDecision.reason,
                    task_run_id: dispatchDecision.task_run_id,
                  }
                : { source: 'request_flag' },
          },
          assertActive: () => assertRequestActive(req.signal),
        });
      } catch (reserveErr) {
        if (!idempotencyKey) throw reserveErr;
        let reconciled: CopilotDurableAcceptance | null;
        try {
          // A rejected COMMIT is not proof of rollback. Wait behind the exact
          // idempotency lock used by reserve, then read the deterministic run:
          // this cannot race ahead of a server-side late COMMIT.
          reconciled = await reconcileCopilotDurableAcceptance(db, idempotencyKey);
        } catch (reconcileErr) {
          throw new CopilotDispatchAmbiguousError(
            new AggregateError(
              [reserveErr, reconcileErr],
              'durable acceptance commit and locked reconciliation were both unavailable',
            ),
          );
        }
        // A successful locked null read proves that the failed transaction did
        // not commit. Preserve its original (possibly 499) definitive error.
        if (!reconciled) throw reserveErr;
        reservation = {
          outcome: reconciled.inputHash === durableInputHash ? 'reused' : 'conflict',
          acceptance: reconciled,
        };
      }
      if (reservation.outcome === 'conflict') {
        throw new ApiError(
          'idempotency_conflict',
          `Idempotency-Key is already bound to durable run ${reservation.acceptance.runId}`,
          409,
        );
      }
      acceptance = reservation.acceptance;
      // ask + QUEUED is now committed: this is the server-side acceptance
      // boundary. Do not strand that durable run if the client disconnects in
      // the commit→send window. Dispatch must finish; a lost response is safely
      // recovered by replaying the same Idempotency-Key.
      // 3) 投递 durable job。run 在 worker 进程跑、进度落 job_events、SSE 经泛化
      //    GET /api/jobs/copilot_run/[run_id]/events（YUK-310 caller-agnostic 路由，
      //    copilot_run 已在其 allowlist）重连；dock 消费端由 YUK-596（PR2）接。
      //    YUK-575 (S4) — ambient RIDE 进 payload（request-only、从不 persisted，worker
      //    拾取时无处可重读；conversation_history / learner-state 则从事件重建）。
      await dispatchAcceptedRun(acceptance, parsed);
      return durableAcceptanceResponse(acceptance);
    } catch (err) {
      // dispatchAcceptedRun owns the complete dispatch-lock critical section,
      // including definitive enqueue-failure compensation. Ambiguous send or
      // readback state intentionally leaves QUEUED for same-key recovery.
      // enqueue 链路任一步失败 → 普通 JSON error（绝不开半截 SSE 流）。run 未受理。
      return errorResponse(err);
    } finally {
      if (reservedDispatchSlot) durableDispatchReservations--;
    }
  }

  const { readable, writable } = new TransformStream();
  const sse = new SSEStreamingApi(writable, readable);

  void (async () => {
    let chain: Promise<void> = Promise.resolve();
    const writeFrame = (event: string, payload: unknown) => {
      chain = chain.then(() => sse.writeSSE({ event, data: JSON.stringify(payload) }));
      return chain;
    };
    const writeHeartbeat = () => {
      chain = chain.then(async () => {
        await sse.write(': keepalive\n\n');
      });
      return chain;
    };
    const heartbeat = setInterval(() => {
      void writeHeartbeat();
    }, COPILOT_INLINE_SSE_HEARTBEAT_MS);
    try {
      const result = await runCopilotChatStreaming(
        db,
        parsed,
        (text) => void writeFrame('delta', { text }),
        {
          // Task lifecycle is projected onto a strict public payload allowlist
          // in the service layer. It shares this FIFO with main-voice deltas.
          onSubtaskEvent: (event) => writeFrame('subtask', event),
          // YUK-457 — per-call tool-use frames for the SPA card renderer.
          // Payload is sanitized at the runner seam; only name + serializable input cross.
          onToolUseEvent: (call) => writeFrame('tool_use', call),
          onToolResultEvent: (result) => writeFrame('tool_result', result),
          providerSessionDeadlineAt,
        },
        req.signal,
      );
      await writeFrame('reply', result);
    } catch (err) {
      // runCopilotChatStreaming 内部降级后 resolve；这里是最后兜底。
      // 脱敏契约同 errorResponse：真实 message+stack 只进服务端日志，
      // 客户端拿固定串。
      const message = err instanceof Error ? err.message : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error('[copilot/chat] unhandled streaming error', {
        message,
        stack,
        timestamp: new Date().toISOString(),
      });
      await writeFrame('reply', { error: 'Internal Server Error' });
    } finally {
      clearInterval(heartbeat);
      await chain.catch(() => undefined);
      await sse.close();
    }
  })();

  return new Response(sse.responseReadable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
