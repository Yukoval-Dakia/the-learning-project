import { defineCapability } from '@/kernel/manifest';

export const agentNotesCapability = defineCapability({
  name: 'agent-notes',
  description:
    'AI 内部协调信道：小 task 给 dreaming/maintenance/coach 留观察信号（hints not facts）；用户侧只读观察窗。',
  events: { actions: ['experimental:agent_note'] },
  api: {
    routes: [
      {
        method: 'GET',
        path: '/api/agents/notes',
        // M0 (YUK-313)：懒加载 thunk——manifest 保持纯元数据（unit 分区不拉 db），
        // server 组合根挂载时才解析 handler。
        load: () => import('./api/notes').then((m) => m.GET),
      },
    ],
  },
  ui: { pages: [{ route: '/agent-notes' }], todayBlocks: ['agent-notes-board'] },
});
