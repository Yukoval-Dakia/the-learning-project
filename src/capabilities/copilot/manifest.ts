import { defineCapability } from '@/kernel/manifest';

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
    ],
  },
  api: {
    routes: [
      {
        method: 'POST',
        path: '/api/copilot/chat',
        load: () => import('./api/chat').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/copilot/turns',
        load: () => import('./api/turns').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/today/copilot-summary',
        load: () => import('./api/copilot-summary').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/teaching-sessions/[id]/accept-chip',
        load: () => import('./api/accept-chip').then((m) => m.POST),
      },
    ],
  },
  // M5-T3 (YUK-321) — copilot 自有工具（事件流读 + 记忆面读 + artifact authoring 写）。
  copilotTools: {
    tools: [
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
