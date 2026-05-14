import { db } from '@/db/client';
import { computeReplay } from '@/server/events/sse_replay';
import { subscribe } from '@/server/events/sse_router';

export const runtime = 'nodejs';
// SSE streams want to stay open; avoid Next caching.
export const dynamic = 'force-dynamic';

/**
 * GET /api/echo/[id]/events —— SSE endpoint for EchoJob status stream.
 *
 * Last-Event-ID header drives replay：从 lastEventId 之后的所有 job_events 一次性
 * 推完，再 subscribe live broadcast。客户端断线重连会接上历史。
 *
 * SSE wire format：每事件一段 `id: <n>\ndata: <json>\n\n`。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id: businessId } = await params;
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
          // Already closed
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

      // 1) Replay missed events (or all if first connection)
      const replay = await computeReplay(db, {
        businessTable: 'echo_jobs',
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

      // 2) Subscribe live —— each NOTIFY brings only the event_id pointer;
      //    fetch the full event row before emitting.
      const unsub = subscribe('echo_jobs', businessId, async (notification) => {
        const incoming = await computeReplay(db, {
          businessTable: 'echo_jobs',
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

      // 3) Cleanup on client disconnect
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
