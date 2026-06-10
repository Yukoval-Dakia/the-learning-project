import { db } from '@/db/client';
import { computeReplay } from '@/server/events/sse_replay';
import { subscribe } from '@/server/events/sse_router';

/**
 * GET /api/ingestion/[id]/events —— SSE 流。
 *
 * 与 /api/echo/[id]/events 模式一致：Last-Event-ID 头驱动 replay + subscribe
 * sse_router live 事件。客户端断线时通过 req.signal abort 自动 unsub。
 */
export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  const businessId = params.id;
  const lastEventIdHeader = req.headers.get('Last-Event-ID');
  const lastEventId = lastEventIdHeader ? Number.parseInt(lastEventIdHeader, 10) : 0;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
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

      const unsub = subscribe('ingestion_session', businessId, async (notification) => {
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
      });

      req.signal.addEventListener('abort', () => {
        unsub();
        close();
      });
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
