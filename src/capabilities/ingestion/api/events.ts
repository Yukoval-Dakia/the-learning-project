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
 * subscribe 回调各自 try/catch（记 console.error + 发一个 SSE error 帧并收口，不让流
 * 静默挂死）；unsubscribe + controller.close 收进单一幂等 close()。live NOTIFY 用
 * max(lastEmittedId, event_id-1) 当 replay 游标去重，避免并发 NOTIFY 交叠时重发帧。
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
      // 去重游标：追踪已 emit 的最大 id（replay 与 live 共同推进）。live NOTIFY 用它当
      // replay 起点，并发 NOTIFY 交叠时避免重放已发过的帧（对齐 sibling job-events.ts）。
      let lastEmittedId = lastEventId;

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

      // 统一 SSE 帧写入：已关闭则跳过；enqueue 抛错（流已 error/close）时走统一
      // close() 完整清理（含 unsub），而非只置 closed —— 否则若此刻 live 订阅已建立，
      // 后续 close() 会被幂等闸短路，unsub 永不执行 → sse_router 订阅永久泄漏。
      // close() 只调 unsub + controller.close，不回调 emitSseFrame，无递归。
      const emitSseFrame = (frame: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(frame));
          return true;
        } catch {
          close();
          return false;
        }
      };

      const emit = (id: number, data: unknown) => {
        // 仅在成功 enqueue 后推进游标——未送达的帧不该抬高去重起点。
        if (emitSseFrame(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`) && id > lastEmittedId) {
          lastEmittedId = id;
        }
      };

      const emitError = () => {
        emitSseFrame('event: error\ndata: {"error":"stream_failed"}\n\n');
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

        // F4 race：初始 replay await 期间客户端可能已断线 —— 那时 close() 已跑过，
        // 但 unsub 尚未赋值，close() 的幂等短路使它永不再清。若此处不早退，await 返回后
        // subscribe() 仍会在已关流上挂一个永不清理的 sse_router 订阅（永久泄漏）。
        // 已关闭则不再起订阅。（replay for-loop 的 emit 已由 emitSseFrame 的 closed 前检守卫。）
        if (closed) return;

        unsub = subscribe('ingestion_session', businessId, async (notification) => {
          try {
            const incoming = await computeReplay(db, {
              businessTable: 'ingestion_session',
              businessId,
              // 去重游标：并发 NOTIFY 交叠时用 max(lastEmittedId, event_id-1) 当 replay
              // 起点，避免重放已发过的帧（单用 event_id-1 会在交叠时重发）。
              lastEventId: Math.max(lastEmittedId, notification.event_id - 1),
            });
            for (const event of incoming) {
              emit(event.id, {
                event_id: event.id,
                event_type: event.event_type,
                payload: event.payload,
              });
            }
          } catch (err) {
            // live-replay 查询失败：记日志 + 发一个 SSE error 事件并收口，不让流静默挂死。
            // 只记 businessId（cuid，非敏感）+ err，不落 event payload。
            console.error('[ingestion:sse] live replay failed', businessId, err);
            emitError();
            close();
          }
        });
      } catch (err) {
        // F2：初始 replay / subscribe 抛错（DB/连接错误）时，记日志 + 发一个 SSE error
        // 事件通知客户端并关闭流 —— 而非让 promise 静默 reject、流永不产数据永不关闭。
        // 只记 businessId（cuid，非敏感）+ err，不落 event payload。
        console.error('[ingestion:sse] initial replay failed', businessId, err);
        emitError();
        close();
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
