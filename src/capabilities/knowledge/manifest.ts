import { defineCapability } from '@/kernel/manifest';

// M3-T1 (YUK-317)：knowledge 包骨架。routes 在 T4（API 上 Hono）逐条填充——
// 8 条：/api/knowledge（树快照）/[id]（节点页）/proposals /proposals/[id]
// /edges /edges/proposals/[id] /review /review-due-summary。
export const knowledgeCapability = defineCapability({
  name: 'knowledge',
  description:
    '知识域：认知结构树（tree 快照 / effective_domain 派生轴——科目是视角不是结构）、' +
    'knowledge_edge 关系网、节点页聚合（node-page，跨包读 notes 导出）、提议双链' +
    '（节点 propose / 边 propose_edge + rubric 校验 + accept/dismiss）、错因归因（attribute）。',
  api: {
    // M3-T4 (YUK-317)：8 条路由全带 load 懒加载 thunk（M1/M2 配方）。静态段
    // proposals/edges/review* 在 Hono 中优先于 :id 匹配。
    routes: [
      {
        method: 'GET',
        path: '/api/knowledge',
        load: () => import('./api/tree').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/knowledge/proposals',
        load: () => import('./api/proposals-list').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/knowledge/proposals/[id]',
        load: () => import('./api/proposal-decide').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/knowledge/edges',
        load: () => import('./api/edges').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/knowledge/edges',
        load: () => import('./api/edges').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/knowledge/edges/proposals/[id]',
        load: () => import('./api/edge-proposal-decide').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/knowledge/review',
        load: () => import('./api/review').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/knowledge/review-due-summary',
        load: () => import('./api/review-due-summary').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/knowledge/[id]',
        load: () => import('./api/node-page-route').then((m) => m.GET),
      },
    ],
  },
});
