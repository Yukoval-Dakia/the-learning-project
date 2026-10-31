import { API_ERROR_RESPONSES, ApiErrorResponseSchema } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { COPILOT_NUDGE_EVALUATE_QUEUE } from '@/server/boss/queue-names';
import {
  AcceptTeachingChipBodySchema,
  AcceptTeachingChipResponseSchema,
  CopilotCancelRunResponseSchema,
  CopilotChatHeadersSchema,
  CopilotChatRequest,
  CopilotCheckpointParamsSchema,
  CopilotCheckpointRevertErrorSchema,
  CopilotCheckpointRevertSuccessSchema,
  CopilotCreateSessionResponseSchema,
  CopilotDurableRunResponseSchema,
  CopilotNudgeCompanionResponseSchema,
  CopilotNudgesResponseSchema,
  CopilotRouteIdParamsSchema,
  CopilotRunParamsSchema,
  CopilotSessionsResponseSchema,
  CopilotSummaryResponseSchema,
  CopilotTurnsQuerySchema,
  CopilotTurnsResponseSchema,
} from './api/contracts';

// copilot 包：单人格对话面。
// 统一记忆读取面：inline/UI replay 走 current-session reader，durable pickup 走
// causal-anchor reader；两者共享同一 projection。
export const copilotCapability = defineCapability({
  name: 'copilot',
  description:
    'Copilot 单人格对话（D13/D14）：自由对话 + chip 直触 SSE 流、turns 重放、' +
    '今日摘要、教学 accept-chip；工具面经 copilotTools 贡献制聚合。',
  events: {
    actions: [
      'experimental:copilot_user_ask',
      'experimental:copilot_chip_trigger',
      'experimental:copilot_reply',
      'experimental:help_explanation_replay',
      'experimental:subagent_run_started',
      'experimental:subagent_run_settled',
      'accept_suggestion',
      // 主动开口触发线：触发留痕 + dismiss/opened 处置留痕（通用 hatch）。
      // KPI 分离：dismiss_rate = dismissed/(opened+dismissed)，不碰 accept_suggestion。
      'experimental:copilot_nudge',
      'experimental:copilot_nudge_dismissed',
      'experimental:copilot_nudge_opened',
    ],
  },
  api: {
    routes: [
      {
        method: 'POST',
        path: '/api/copilot/chat',
        operationId: 'runCopilotChat',
        request: { headers: CopilotChatHeadersSchema, body: CopilotChatRequest },
        responses: {
          202: CopilotDurableRunResponseSchema,
          ...API_ERROR_RESPONSES,
          499: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
        successStatus: [202],
        load: () => import('./api/chat').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/copilot/checkpoints/[eventId]/revert',
        operationId: 'revertCopilotCheckpoint',
        request: { params: CopilotCheckpointParamsSchema },
        // 404 (no_checkpoint) / 409 (truncated/irreversible/legacy/conflict)
        // return the cascade refusal envelope, not the bare {error,message} the
        // spread implies; override those statuses with the union that also admits
        // the route's ApiError bodies.
        responses: {
          200: CopilotCheckpointRevertSuccessSchema,
          ...API_ERROR_RESPONSES,
          404: CopilotCheckpointRevertErrorSchema,
          409: CopilotCheckpointRevertErrorSchema,
        },
        successStatus: 200,
        load: () => import('./api/revert-checkpoint').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/copilot/runs/[id]/cancel',
        operationId: 'cancelCopilotRun',
        request: { params: CopilotRunParamsSchema },
        responses: { 200: CopilotCancelRunResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: async () => {
          const [{ buildCancelCopilotRunHandler }, { dispatchSessionHead }, { db }, bossClient] =
            await Promise.all([
              import('./api/cancel-run'),
              import('./server/durable-dispatch'),
              import('@/db/client'),
              import('@/server/boss/client'),
            ]);
          return buildCancelCopilotRunHandler({
            wakeSession: async (sessionId) =>
              dispatchSessionHead(db, sessionId, {
                boss: await bossClient.getStartedBoss(),
                transactionDb: bossClient.fromPgBossDrizzleTx,
              }),
          });
        },
      },
      {
        method: 'GET',
        path: '/api/copilot/sessions',
        operationId: 'listCopilotSessions',
        responses: { 200: CopilotSessionsResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/sessions').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/copilot/sessions',
        operationId: 'createCopilotSession',
        responses: { 201: CopilotCreateSessionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/sessions').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/copilot/turns',
        operationId: 'listCopilotTurns',
        request: { query: CopilotTurnsQuerySchema },
        responses: { 200: CopilotTurnsResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/turns').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/today/copilot-summary',
        operationId: 'getTodayCopilotSummary',
        responses: { 200: CopilotSummaryResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/copilot-summary').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/teaching-sessions/[id]/accept-chip',
        operationId: 'acceptTeachingSessionChip',
        request: {
          params: CopilotRouteIdParamsSchema,
          body: AcceptTeachingChipBodySchema,
        },
        responses: { 200: AcceptTeachingChipResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/accept-chip').then((m) => m.POST),
      },
      // 主动开口 nudge 面：读（排 shadow/过期/已处置 + 静默窗 backstop）+ 处置（× / 看看）。
      {
        method: 'GET',
        path: '/api/copilot/nudges',
        operationId: 'listCopilotNudges',
        responses: { 200: CopilotNudgesResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/nudges').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/copilot/nudges/[id]/dismiss',
        operationId: 'dismissCopilotNudge',
        request: { params: CopilotRouteIdParamsSchema },
        responses: { 200: CopilotNudgeCompanionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/nudges').then((m) => m.dismissPOST),
      },
      {
        method: 'POST',
        path: '/api/copilot/nudges/[id]/opened',
        operationId: 'markCopilotNudgeOpened',
        request: { params: CopilotRouteIdParamsSchema },
        responses: { 200: CopilotNudgeCompanionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/nudges').then((m) => m.openedPOST),
      },
    ],
  },
  // durable copilot run job（贡献制，无 schedule = 按需 job）。route dispatch（durable
  // 标记）→ boss.send('copilot_run') → handler 在 worker 进程跑 CopilotTask + 全集工具，
  // 进度落 job_events。queue 'agent' 档（EXPIRE_AGENT，同 quiz_gen 等 tool-call agent
  // job）；注册器固定 batchSize:1 → n=1 单线程串行化。挂载由
  // register-capability-jobs.ts 收集。
  jobs: {
    handlers: [
      {
        name: 'copilot_run',
        queue: 'agent',
        // The generic agent expiry is 2h. A 30s heartbeat lets pg-boss turn a
        // crashed active delivery into retry/failed evidence promptly; the
        // Copilot reconciler still never guesses from heartbeat timestamps.
        heartbeatSeconds: 30,
        load: async () => {
          const [{ buildCopilotRunHandler }, { dispatchSessionHead }, bossClient] =
            await Promise.all([
              import('./jobs/copilot_run'),
              import('./server/durable-dispatch'),
              import('@/server/boss/client'),
            ]);
          return (db) =>
            buildCopilotRunHandler(db, {
              wakeSession: async (sessionId) =>
                dispatchSessionHead(db, sessionId, {
                  boss: await bossClient.getStartedBoss(),
                  transactionDb: bossClient.fromPgBossDrizzleTx,
                }),
            });
        },
      },
      // 主动开口触发评估器（按需 job，无 schedule）。producer（ingestion 完成）
      // boss.send(COPILOT_NUDGE_EVALUATE_QUEUE) → 本 handler 确定性判定 + 写触发留痕。
      // FAST 档：纯-DB 零-LLM，不占 agent 档的 DLQ/retry 语义；幂等由 partial unique
      // index（caused_by_event_id）保证。queue 名 = 导出常量，producer 与此处共享
      // 以防跨包漂移。
      {
        name: COPILOT_NUDGE_EVALUATE_QUEUE,
        queue: 'fast',
        load: () =>
          import('./jobs/copilot_nudge_evaluate').then((m) => m.buildCopilotNudgeEvaluateHandler),
      },
      {
        // Even-minute, zero-LLM convergence floor for accepted durable runs. The
        // two-minute cadence stays below the 15-minute liveness bound while avoiding
        // a duplicate manifest cron declaration. It repairs persisted outcome markers
        // and settles only queue-proven pre-execution loss or expired ambiguous
        // executions.
        name: 'copilot_run_reconcile',
        schedule: {
          cron: '0-58/2 * * * *',
          tz: 'Asia/Shanghai',
          singletonKey: 'copilot_run_reconcile-sweep',
          singletonSeconds: 120,
        },
        queue: 'fast',
        load: () =>
          import('./jobs/copilot_run_reconcile').then((m) => m.buildCopilotRunReconcileHandler),
      },
    ],
  },
  // copilot 自有工具（事件流读 + 记忆面读）。
  // artifact 工具的归属声明在 notes manifest；Copilot 只保留 allowlist 授权，
  // 不再是 implementation owner。
  copilotTools: {
    tools: [
      {
        name: 'present_primary_view',
        load: () =>
          import('./server/tools/present-primary-view').then((m) => m.presentPrimaryViewTool),
      },
      {
        name: 'query_events',
        load: () => import('./server/tools/query-events').then((m) => m.queryEventsTool),
      },
      {
        name: 'query_memory_brief',
        load: () => import('./server/tools/memory-brief').then((m) => m.queryMemoryBriefTool),
      },
      {
        name: 'search_memory_facts',
        load: () =>
          import('./server/tools/search-memory-facts').then((m) => m.searchMemoryFactsTool),
      },
    ],
  },
});
