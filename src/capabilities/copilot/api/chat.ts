// M5-T3 (YUK-321) — POST /api/copilot/chat（SSE）。
// 等价平移 app/api/copilot/chat/route.ts：两 surface（chat | chip）路由契约、
// delta/reply 帧语义、parse-before-stream、错误串脱敏三件不变。
// 形态变更仅一处（M5 唯一运行时形态变更）：手工 ReadableStream → hono
// SSEStreamingApi 自构 Response（裁决 j：RouteHandler 是 Web 标准签名，不经
// hono Context，故不用 streamSSE(c)）。delta 回调是同步 (text)=>void、
// writeSSE 是 async —— promise chain 保 FIFO。

import { SSEStreamingApi } from 'hono/streaming';
import { ZodError } from 'zod';

import { CopilotChatRequest, runCopilotChatStreaming } from '@/capabilities/copilot/server/chat';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

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
