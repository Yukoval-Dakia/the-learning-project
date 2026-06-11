import { defineCapability } from '@/kernel/manifest';

// M3-T1 (YUK-317)：notes 包骨架。routes 在 T4（API 上 Hono）逐条填充——
// 9 条：notes/[id] GET + artifacts/[id]/{body-blocks,sections/[sectionId],
// backlinks,correct,ai-changes,ai-changes/[eventId]/undo} + artifacts/search
// + hubs/[id]/dismiss-link。
export const notesCapability = defineCapability({
  name: 'notes',
  description:
    '笔记域：artifact 笔记的读（note-page 聚合 / notes-read 按知识点）、写（body-blocks 块编辑 ' +
    '乐观锁 / sections / block-refs 反链索引）与 Living Note refine 链（triggers→policy→' +
    'mutator|propose，D6 后信号源 = mark_wrong/mastery_change/dwell/dreaming）。',
  api: {
    // M3-T4 (YUK-317)：9 条路由全带 load 懒加载 thunk（M1/M2 配方）。
    // /api/editing-session/*、/api/embedded-check/* 不在此（前者 ⚖️ 争议行留
    // 旧栈，后者 D6 墓碑）。
    routes: [
      {
        method: 'GET',
        path: '/api/notes/[id]',
        load: () => import('./api/note-page-route').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/artifacts/search',
        load: () => import('./api/artifacts-search').then((m) => m.GET),
      },
      {
        method: 'PATCH',
        path: '/api/artifacts/[id]/body-blocks',
        load: () => import('./api/body-blocks-route').then((m) => m.PATCH),
      },
      {
        method: 'PATCH',
        path: '/api/artifacts/[id]/sections/[sectionId]',
        load: () => import('./api/section-edit').then((m) => m.PATCH),
      },
      {
        method: 'GET',
        path: '/api/artifacts/[id]/backlinks',
        load: () => import('./api/backlinks').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/artifacts/[id]/correct',
        load: () => import('./api/correct').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/artifacts/[id]/correct',
        load: () => import('./api/correct').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/artifacts/[id]/ai-changes',
        load: () => import('./api/ai-changes').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/artifacts/[id]/ai-changes/[eventId]/undo',
        load: () => import('./api/ai-change-undo').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/hubs/[id]/dismiss-link',
        load: () => import('./api/hub-dismiss-link').then((m) => m.POST),
      },
    ],
  },
});
