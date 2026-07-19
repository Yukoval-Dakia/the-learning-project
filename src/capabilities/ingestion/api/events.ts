import { db } from '@/db/client';
import { computeReplay } from '@/server/events/sse_replay';
import { subscribe } from '@/server/events/sse_router';

/**
 * GET /api/ingestion/[id]/events —— SSE 流。
 *
 * 与 /api/echo/[id]/events 模式一致：Last-Event-ID 头驱动 replay + subscribe
 * sse_router live 事件。客户端断线时通过 req.signal abort 自动 unsub。
 *
 * Resilience guards（YUK-730，对齐 sibling observability/api/job-events.ts）：
 * F1 非数字 Last-Event-ID 经 parseInt 得 NaN，守卫降级为 0（= 全量 replay）；
 * F4 abort 监听器在任何 await 之前注册 + aborted 前检，客户端在初始 replay 期间
 * 断线也能触发 unsub + close，避免 stream + DB 订阅泄漏；F2 初始 replay 与 live
 * subscribe 回调各自 try/catch，DB/连接错误发一个 SSE error 帧并收口，不让流静默
 * 挂死；unsubscribe + controller.close 收进单一幂等 close()。
 *
 * 与 sibling 的差异：ingestion 路由 businessTable 恒为字面量 'ingestion_session'
 * （永不空、非用户提供），故不需要 sibling 的 kind/id 400 闸与 business_table
 * allowlist（那两闸只为防用户提供的 kind 订阅任意表）。
 */
export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  const businessId = params.id;
  const lastEventIdHeader = req.headers.get('Last-Event-ID');
  // F1：非数字头（如 'abc'）经 parseInt 得 NaN，会一路流进 gt(id, NaN) 导致
  // Postgres 22P02 报错 / 静默零行。NaN 守卫降级为 0（= 全量 replay）。
  const parsed = lastEventIdHeader ? Number.parseInt(lastEventIdHeader, 10) : 0;
  const lastEventId = Number.isNaN(parsed) ? 0 : parsed;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unsub: (() => void) | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        // F2/F4：清理订阅 + 关闭 controller 在同一处收口，无论正常 abort 还是异常路径。
        unsub?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      const emit = (id: number, data: unknown) => {
        if (closed) return;
        const payload = `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          closed = true;
        }
      };

      // F4：abort 监听器在任何 await 之前注册 —— 客户端在初始 replay 期间断线也能
      // 触发 unsub + close，避免 stream + DB 订阅泄漏。
      req.signal.addEventListener('abort', close);

      // 已断线（abort 在进入 start 前就触发）时直接收口，不起订阅。
      if (req.signal.aborted) {
        close();
        return;
      }

      try {
        const replay = await computeReplay(db, {
          businessTable: 'ingestion_session',
          businessId,
          lastEventId,
        });
        for (const event of replay) {
          emit(event.id, {
            event_id: event.id,
            event_type: event.event_type,
            payload: event.payload,
          });
        }

        unsub = subscribe('ingestion_session', businessId, async (notification) => {
          try {
            const incoming = await computeReplay(db, {
              businessTable: 'ingestion_session',
              businessId,
              lastEventId: notification.event_id - 1,
            });
            for (const event of incoming) {
              emit(event.id, {
                event_id: event.id,
                event_type: event.event_type,
                payload: event.payload,
              });
            }
          } catch {
            // live-replay 查询失败：发一个 SSE error 事件并收口，不让流静默挂死。
            emitError();
            close();
          }
        });
      } catch {
        // F2：初始 replay / subscribe 抛错（DB/连接错误）时，发一个 SSE error 事件
        // 通知客户端并关闭流 —— 而非让 promise 静默 reject、流永不产数据永不关闭。
        emitError();
        close();
      }

      function emitError() {
        if (closed) return;
        const payload = 'event: error\ndata: {"error":"stream_failed"}\n\n';
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // already closed / errored
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
