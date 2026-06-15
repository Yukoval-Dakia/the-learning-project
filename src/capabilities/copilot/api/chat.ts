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
  runCopilotChatStreaming,
  writeCopilotReply,
  writeCopilotUserAsk,
} from '@/capabilities/copilot/server/chat';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
} from '@/capabilities/copilot/server/copilot-run-status';
import { db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError, errorResponse } from '@/server/http/errors';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { Conversation } from '@/server/session';

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

  // YUK-364 (ADR-0041 endurance W1 L2) — durable 分流。判定阈值 v1 = 显式
  // `durable` 标记（最粗、最不误伤短活；先粗、实测后调）。仅 chat surface 入
  // durable 面（chip 是 UI 直触轻活，不写 user_ask；durable 标记落在 chip 上
  // 时降级回 inline，下方守卫）。shouldEnqueueBackgroundJobs() 在测试环境为 false
  // → 即便带 durable 标记也走 inline（与 session-end 等 enqueue 守门同款）。
  if (parsed.durable && parsed.triggered_by === 'chat' && shouldEnqueueBackgroundJobs()) {
    // YUK-364 (F2) — 补偿用的局部状态：只在 user_ask 已 commit 后才需要补偿（否则
    // 没有 phantom 风险），所以记录 runId / sessionId 是否已知。
    let runId: string | undefined;
    let sessionId: string | undefined;
    try {
      // 1) 复用 inline 同一会话信封——durable run 的 user_ask / 回复事件共享 session_id。
      const conv = await Conversation.findOrCreateCopilotConversation(db, {});
      sessionId = conv.sessionId;
      // 2) 写 user_ask domain event = run handle = checkpoint_id（与 inline 同一份
      //    写入逻辑，防漂移）。run_id 既是 handle 也是 job_events business_id。
      runId = await writeCopilotUserAsk(db, {
        sessionId,
        userMessage: parsed.user_message,
        now: new Date(),
      });
      // 3) queued 初态进度事件——消费者订阅后即见 run 已受理（worker 拾起前）。
      await writeJobEvent(db, {
        business_table: COPILOT_RUN_TABLE,
        business_id: runId,
        event_type: COPILOT_RUN_EVENTS.QUEUED,
        payload: { session_id: sessionId, triggered_by: parsed.triggered_by },
      });
      // 4) 投递 durable job。run 在 worker 进程跑、进度落 job_events、SSE 经
      //    GET /api/copilot/runs/[id]/events（消费端 UI 是后续 lane）重连。
      const boss = await getStartedBoss();
      await boss.send('copilot_run', {
        run_id: runId,
        session_id: sessionId,
        user_message: parsed.user_message,
        triggered_by: parsed.triggered_by,
        ...(parsed.chip_kind ? { chip_kind: parsed.chip_kind } : {}),
      });
      // 202 Accepted — run handle 回给客户端用于订阅；非 SSE（durable 面与同步
      // SSE 面是两条返回契约）。
      return Response.json({ run_id: runId, session_id: sessionId }, { status: 202 });
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
            payload: { reason: 'enqueue_failed' },
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
        {},
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
