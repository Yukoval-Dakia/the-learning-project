// M5-T3 (YUK-321) — POST /api/copilot/chat（SSE）。
// 等价平移 app/api/copilot/chat/route.ts：两 surface（chat | chip）路由契约、
// delta/reply 帧语义、parse-before-stream、错误串脱敏三件不变。
// 形态变更仅一处（M5 唯一运行时形态变更）：手工 ReadableStream → hono
// SSEStreamingApi 自构 Response（裁决 j：RouteHandler 是 Web 标准签名，不经
// hono Context，故不用 streamSSE(c)）。delta 回调是同步 (text)=>void、
// writeSSE 是 async —— promise chain 保 FIFO。

import { SSEStreamingApi } from 'hono/streaming';
import { ZodError } from 'zod';

import {
  CopilotChatRequest,
  decideCopilotDispatch,
  runCopilotChatStreaming,
  writeCopilotReply,
  writeCopilotUserAsk,
} from '@/capabilities/copilot/server/chat';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import {
  MAX_OUTSTANDING_DURABLE_RUNS,
  countOutstandingDurableRuns,
} from '@/capabilities/copilot/server/durable-backlog';
// YUK-575 (N6/MF-C) — the pickup-timeout deadline stamped on the QUEUED event so a
// consumer (PR2 Dock, isDurablePickupStalled) can detect a worker-down stall.
import { PICKUP_TIMEOUT_MS } from '@/capabilities/copilot/server/durable-pickup';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { getStartedBoss } from '@/server/boss/client';
import { writeJobEvent } from '@/server/events/writer';
import { checkRateLimit } from '@/server/http/rate-limit';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { Conversation } from '@/server/session';

// Closes the count-then-enqueue race inside the single Hono API process. A slot
// moves from this counter into durable job_events once QUEUED is committed.
let durableDispatchReservations = 0;

function requestAbortedError(): ApiError {
  // 499 is the conventional server-side status for a client-closed request.
  // The caller is already gone; the important contract is that no new durable
  // side effect is committed after this guard observes the abort.
  return new ApiError('request_aborted', 'request aborted before acceptance', 499);
}

function assertRequestActive(signal: AbortSignal): void {
  if (signal.aborted) throw requestAbortedError();
}

// 签名对齐 kernel RouteHandler 双参形（path 无参数段，_params 不用）。
export async function POST(req: Request, _params: Record<string, string>): Promise<Response> {
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

  const backgroundJobsEnabled = shouldEnqueueBackgroundJobs();
  const dispatchDecision =
    parsed.durable === undefined &&
    parsed.triggered_by === 'chat' &&
    !parsed.skill_context &&
    backgroundJobsEnabled
      ? await decideCopilotDispatch(
          db,
          {
            user_message: parsed.user_message,
            ...(parsed.ambient_context ? { ambient_context: parsed.ambient_context } : {}),
          },
          { signal: req.signal },
        )
      : undefined;
  // The model judgment happens before the 200/202 acceptance boundary. If the
  // client disconnected while it was in flight, do not turn its now-ambiguous
  // failed POST into a paid durable run that a retry could duplicate.
  if (req.signal.aborted) return errorResponse(requestAbortedError());
  const durableRequested = parsed.durable === true || dispatchDecision?.mode === 'durable';

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
    // YUK-364 (F2) — 补偿用的局部状态：只在 user_ask 已 commit 后才需要补偿（否则
    // 没有 phantom 风险），所以记录 runId / sessionId 是否已知。
    let runId: string | undefined;
    let sessionId: string | undefined;
    let reservedDispatchSlot = false;
    try {
      assertRequestActive(req.signal);
      // YUK-693 — bound both a short request burst and the durable backlog. The
      // process-local reservation closes concurrent count→enqueue races; the DB
      // query remains the durable source of truth across restarts/processes.
      checkRateLimit();
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

      // 1) 复用 inline 同一会话信封——durable run 的 user_ask / 回复事件共享 session_id。
      const conv = await Conversation.findOrCreateCopilotConversation(db, {});
      assertRequestActive(req.signal);
      sessionId = conv.sessionId;
      // 2) 写 user_ask domain event = run handle = checkpoint_id（与 inline 同一份
      //    写入逻辑，防漂移）。run_id 既是 handle 也是 job_events business_id。
      runId = await writeCopilotUserAsk(db, {
        sessionId,
        userMessage: parsed.user_message,
        now: new Date(),
      });
      // 3) queued 初态进度事件——消费者订阅后即见 run 已受理（worker 拾起前）。
      //    YUK-575 (N6) — 盖 pickup_deadline_ms：worker 若没在此前拾取（写 STARTED），
      //    isDurablePickupStalled 谓词据它检出 worker-down 停摆（PR2 Dock 主动 surface）。
      await writeJobEvent(db, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.QUEUED,
        payload: {
          session_id: sessionId,
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
      });
      // 4) 投递 durable job。run 在 worker 进程跑、进度落 job_events、SSE 经泛化
      //    GET /api/jobs/copilot_run/[run_id]/events（YUK-310 caller-agnostic 路由，
      //    copilot_run 已在其 allowlist）重连；dock 消费端由 YUK-596（PR2）接。
      //    YUK-575 (S4) — ambient RIDE 进 payload（request-only、从不 persisted，worker
      //    拾取时无处可重读；conversation_history / learner-state 则从事件重建）。
      const boss = await getStartedBoss();
      await boss.send('copilot_run', {
        run_id: runId,
        session_id: sessionId,
        user_message: parsed.user_message,
        triggered_by: parsed.triggered_by,
        ...(parsed.chip_kind ? { chip_kind: parsed.chip_kind } : {}),
        ...(parsed.ambient_context ? { ambient: parsed.ambient_context } : {}),
      });
      // 202 Accepted — run handle 回给客户端用于订阅；非 SSE（durable 面与同步
      // SSE 面是两条返回契约）。
      return Response.json(
        { run_id: runId, session_id: sessionId, checkpoint_event_id: runId },
        {
          status: 202,
          headers: {
            Location: `/api/jobs/copilot_run/${encodeURIComponent(runId)}/events`,
          },
        },
      );
    } catch (err) {
      // YUK-364 (F2) — enqueue 链路失败补偿。若 user_ask + QUEUED 已 commit 但
      // boss.send（或之后任一步）throw，job 没投递 → user_ask 成 phantom
      // （conversation_history 见一条无回复的 user 轮）+ deriveCopilotRunStatus 永远
      // 卡 'queued'。补偿：写一条 FAILED job_event（status→failed 非卡死 queued）+
      // 一条 copilot_reply error domain event（chained user_ask）让该轮不是 phantom。
      // 只在 runId 已知（= user_ask 已写）时补偿；conversation/user_ask 写入前失败
      // 无 phantom 风险，照旧返 error 即可。补偿本身 best-effort，不能吞原始错误。
      if (runId && sessionId) {
        try {
          await writeJobEvent(db, {
            business_table: COPILOT_RUN_TABLE,
            business_id: runId,
            event_type: COPILOT_RUN_EVENTS.FAILED,
            payload: { reason: 'enqueue_failed', checkpoint_event_id: runId },
          });
          await writeCopilotReply(db, {
            sessionId,
            userAskEventId: runId,
            replyText: 'run 未能受理（enqueue 失败）。请重试。',
            actorRef: 'agent:copilot',
            taskRunId: `copilot_run_enqueue_failed_${runId}`,
            now: new Date(),
          });
        } catch (compErr) {
          console.error(
            '[copilot/chat] durable enqueue-failure compensation failed for',
            runId,
            compErr,
          );
        }
      }
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
    try {
      const result = await runCopilotChatStreaming(
        db,
        parsed,
        (text) => void writeFrame('delta', { text }),
        {
          // Task lifecycle is projected onto a strict public payload allowlist
          // in the service layer. It shares this FIFO with main-voice deltas.
          onSubtaskEvent: (event) => writeFrame('subtask', event),
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
