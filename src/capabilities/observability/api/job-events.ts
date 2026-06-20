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

/**
 * Allowlist of known job-event business tables (YUK-310 F3, PR #530 review).
 *
 * `kind` 现在是用户提供（ingestion 路由里它是字面量 'ingestion_session' 永不空），
 * 没有白名单则任意已认证 caller 都能订阅任意 business_table 的事件流 —— 跨域读权限
 * 隐患。这里枚举所有真实 writeJobEvent 写入站点用过的 business_table（源码反查）：
 *   - ingestion_session  src/server/events/ingestion-progress.ts / session/ingestion.ts / session/docx-ingestion.ts
 *   - copilot_run        src/capabilities/copilot/server/copilot-run-status.ts (COPILOT_RUN_TABLE)
 *   - echo_jobs          src/server/boss/handlers/echo.ts
 *   - question_block     src/capabilities/ingestion/server/block-structured-edit.ts
 *   - learning_session   src/server/session/{tutor,review,conversation}.ts (SESSION_TABLE)
 * 新增 writeJobEvent 写入新 business_table 时，必须在此同步追加，否则该流会 400。
 */
const ALLOWED_BUSINESS_TABLES = new Set<string>([
  'ingestion_session',
  'copilot_run',
  'echo_jobs',
  'question_block',
  'learning_session',
]);

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

  // GUARD（F3）：未知 business_table 直接 400，禁止订阅任意表的事件流。
  if (!ALLOWED_BUSINESS_TABLES.has(businessTable)) {
    return new Response(JSON.stringify({ error: 'unknown kind' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const lastEventIdHeader = req.headers.get('Last-Event-ID');
  // F1：非数字头（如 'abc'）经 parseInt 得 NaN，会一路流进 gt(id, NaN) 导致不可预测
  // 的查询行为（Postgres 直接 22P02 报错 / 静默零行）。NaN 守卫降级为 0（= 全量 replay）。
  const parsed = lastEventIdHeader ? Number.parseInt(lastEventIdHeader, 10) : 0;
  const lastEventId = Number.isNaN(parsed) ? 0 : parsed;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unsub: (() => void) | undefined;
      // kody :86 — 追踪已 emit 的最大 id。live NOTIFY 用 notification.event_id - 1
      // 当游标时，若两条写入交叠会重放已发过的帧；用 max(lastEmittedId, ...) 当游标
      // 确保每条 id 只发一次（去重）。
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

      const emit = (id: number, data: unknown) => {
        if (closed) return;
        const payload = `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
          if (id > lastEmittedId) lastEmittedId = id;
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

        unsub = subscribe(businessTable, businessId, async (notification) => {
          try {
            const incoming = await computeReplay(db, {
              businessTable,
              businessId,
              lastEventId: Math.max(lastEmittedId, notification.event_id - 1),
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
