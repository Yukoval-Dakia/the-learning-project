import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { COPILOT_NUDGE_EVALUATE_QUEUE } from '@/server/boss/queue-names';
import {
  AcceptTeachingChipBodySchema,
  AcceptTeachingChipResponseSchema,
  CopilotChatRequest,
  CopilotChatStreamResponseSchema,
  CopilotCheckpointParamsSchema,
  CopilotCheckpointRevertErrorSchema,
  CopilotCheckpointRevertResponseSchema,
  CopilotDurableRunResponseSchema,
  CopilotNudgeCompanionResponseSchema,
  CopilotNudgesResponseSchema,
  CopilotRouteIdParamsSchema,
  CopilotSummaryResponseSchema,
  CopilotTurnsQuerySchema,
  CopilotTurnsResponseSchema,
} from './api/contracts';

// M5-T3 (YUK-321) — copilot 包：D14 单人格对话面（D13 权限继承框架内）。
// 统一记忆读取面 = server/chat.ts 既有 ambient context 装配 + server/turns.ts
// getRecentCopilotTurns（第一实例原则：不另立抽象，包边界即读取面——裁决 k）。
// copilotTools 五条本包工具在 Task 3 与其余四包一并声明。
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
      'accept_suggestion',
      // YUK-577 — 主动开口触发线：触发留痕（RESERVED+typed，nudge-events.ts）+ dismiss/opened
      // 处置留痕（通用 hatch）。KPI 分离：dismiss_rate = dismissed/(opened+dismissed)，不碰 accept_suggestion。
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
        request: { body: CopilotChatRequest },
        responses: {
          200: CopilotChatStreamResponseSchema,
          202: CopilotDurableRunResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        responseMediaTypes: { 200: 'text/event-stream' },
        successStatus: [200, 202],
        load: () => import('./api/chat').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/copilot/checkpoints/[eventId]/revert',
        operationId: 'revertCopilotCheckpoint',
        request: { params: CopilotCheckpointParamsSchema },
        // YUK-497 review F3 — 404 (no_checkpoint) / 409 (truncated/irreversible/legacy/conflict)
        // return the cascade refusal envelope, NOT the bare {error,message} the spread implies;
        // override those two statuses with the union that also admits the route's ApiError bodies.
        responses: {
          200: CopilotCheckpointRevertResponseSchema,
          ...API_ERROR_RESPONSES,
          404: CopilotCheckpointRevertErrorSchema,
          409: CopilotCheckpointRevertErrorSchema,
        },
        successStatus: 200,
        load: () => import('./api/revert-checkpoint').then((m) => m.POST),
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
      // YUK-577 — 主动开口 nudge 面：读（排 shadow/过期/已处置 + 静默窗 backstop）+ 处置（× / 看看）。
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
  // YUK-364 (ADR-0041 endurance W1 L2) — durable copilot run job（贡献制，无
  // schedule = 按需 job）。route dispatch（durable 标记）→ boss.send('copilot_run')
  // → handler 在 worker 进程跑 CopilotTask + 全集工具，进度落 job_events。queue
  // 'agent' 档（EXPIRE_AGENT，同 quiz_gen 等 tool-call agent job）；注册器固定
  // batchSize:1 → n=1 单线程串行化。挂载由 register-capability-jobs.ts 收集。
  jobs: {
    handlers: [
      {
        name: 'copilot_run',
        queue: 'agent',
        load: () =>
          import('@/server/boss/handlers/copilot_run').then((m) => m.buildCopilotRunHandler),
      },
      // YUK-577 — 主动开口触发评估器（按需 job，无 schedule）。producer（ingestion 完成）
      // boss.send(COPILOT_NUDGE_EVALUATE_QUEUE) → 本 handler 确定性判定 + 写触发留痕。
      // FAST 档（should#1）：纯-DB 零-LLM，不占 agent 档的 DLQ/retry LLM-记账语义；
      // 幂等由 partial unique index（caused_by_event_id）保证。queue 名 = 导出常量
      // COPILOT_NUDGE_EVALUATE_QUEUE，producer 与此处共享（should#8 防跨包漂移）。
      {
        name: COPILOT_NUDGE_EVALUATE_QUEUE,
        queue: 'fast',
        load: () =>
          import('./jobs/copilot_nudge_evaluate').then((m) => m.buildCopilotNudgeEvaluateHandler),
      },
    ],
  },
  // M5-T3 (YUK-321) — copilot 自有工具（事件流读 + 记忆面读 + artifact authoring 写）。
  copilotTools: {
    tools: [
      {
        name: 'run_task',
        load: () => import('@/server/ai/tools/run-task').then((m) => m.runTaskTool),
      },
      {
        name: 'query_events',
        load: () => import('@/server/ai/tools/query-events').then((m) => m.queryEventsTool),
      },
      {
        name: 'query_memory_brief',
        load: () => import('@/server/ai/tools/context-readers').then((m) => m.queryMemoryBriefTool),
      },
      {
        name: 'search_memory_facts',
        load: () =>
          import('@/server/ai/tools/search-memory-facts').then((m) => m.searchMemoryFactsTool),
      },
      {
        name: 'author_artifact',
        load: () => import('@/server/ai/tools/author-artifact').then((m) => m.authorArtifactTool),
      },
      {
        name: 'update_artifact',
        load: () => import('@/server/ai/tools/author-artifact').then((m) => m.updateArtifactTool),
      },
    ],
  },
});
