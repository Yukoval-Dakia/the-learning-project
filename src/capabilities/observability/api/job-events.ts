import { db } from '@/db/client';
import { computeReplay } from '@/server/events/sse_replay';
import { subscribe } from '@/server/events/sse_router';

/**
 * GET /api/jobs/[kind]/[id]/events —— 通用异步 job tracker SSE 流（YUK-310）。
 *
 * 把 ingestion/api/events.ts 的 per-domain SSE 提升为 caller-agnostic：业务表名
 * 不再硬编码 'ingestion_session'，改由路由参数 `kind` 提供，业务 id 由 `id` 提供。
 * 任何写 job_events 的域（copilot_run 是首个消费者）都能复用同一条流。
 * job_events 表本就泛型（business_table/business_id），无需 schema 变更。
 *
 * 与 ingestion 路由模式一致：Last-Event-ID 头驱动 replay + subscribe sse_router
 * live 事件；客户端断线时通过 req.signal abort 自动 unsub + close。
 *
 * 留存（owner-decision）：服务端 terminal-close 谓词（v1 = 客户端 abort 关闭，
 * 对齐 ingestion）+ one-shot 快照 GET /api/jobs/[kind]/[id]（Phase-3 随 run-card）。
 */
export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  const businessTable = params.kind;
  const businessId = params.id;

  // GUARD：kind / id 现在是用户提供（ingestion 路由里 kind 是字面量永不空）。
  // 缺失或空段直接 400，避免对空 business_table/business_id 起订阅。
  if (!businessTable || !businessId) {
    return new Response(JSON.stringify({ error: 'missing kind or id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
        businessTable,
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

      const unsub = subscribe(businessTable, businessId, async (notification) => {
        const incoming = await computeReplay(db, {
          businessTable,
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
