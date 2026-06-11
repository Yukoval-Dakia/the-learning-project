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
    routes: [],
  },
});
