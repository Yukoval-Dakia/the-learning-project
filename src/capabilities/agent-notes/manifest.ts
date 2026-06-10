import { defineCapability } from '@/kernel/manifest';

export const agentNotesCapability = defineCapability({
  name: 'agent-notes',
  description:
    'AI 内部协调信道：小 task 给 dreaming/maintenance/coach 留观察信号（hints not facts）；用户侧只读观察窗。',
  events: { actions: ['experimental:agent_note'] },
  api: { routes: [{ method: 'GET', path: '/api/agents/notes' }] },
  ui: { pages: [{ route: '/agent-notes' }], todayBlocks: ['agent-notes-board'] },
});
