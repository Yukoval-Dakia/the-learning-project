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
        // A5 S2 (YUK-354)：FrontierRail 读模型（learnable_frontier 横幅）。静态段，
        // 须在 :id catch-all 之前匹配（同 proposals/edges/review*）。
        method: 'GET',
        path: '/api/knowledge/frontier',
        load: () => import('./api/frontier').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/knowledge/[id]',
        load: () => import('./api/node-page-route').then((m) => m.GET),
      },
      {
        // A5 S4 (YUK-531)：per-KC 误区 funnel 读模型（「指向此点的误区」）。4 段路径
        // （:id/misconceptions），与 frontier(3 段)/[id](3 段) 无段数碰撞，顺序无关。
        method: 'GET',
        path: '/api/knowledge/[id]/misconceptions',
        load: () => import('./api/misconceptions').then((m) => m.GET),
      },
    ],
  },
  jobs: {
    // M4-T3 (YUK-319) + Lane D (YUK-482)：夜链 cron + 链式 attribution followup 入容器。
    // cron/链式形态照 handlers.ts 现状；注册由 server/boss/register-capability-jobs.ts
    // 收集挂载，此处声明是唯一归属源。
    handlers: [
      // Lane D (YUK-482): knowledge_propose_nightly was removed — its sole job was
      // getFailureAttempts → propose-new-KC, i.e. answer-wrong → propose coupling.
      // KC creation is a CONTENT-axis action (driven by what the material covers),
      // independent of answer correctness; failures are PERFORMANCE-axis and feed
      // 错因/mastery only. KC creation lives in the content-driven paths
      // (cold-start-bridge / image-candidate-accept matcher / agent proposal tools)
      // plus the maintenance producer KnowledgeReviewTask (knowledge_maintenance_nightly).
      {
        // Phase 2 Dreaming：knowledge_edge mesh propose（BJT 02:30，node propose 后）。
        name: 'knowledge_edge_propose_nightly',
        schedule: { cron: '30 2 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/knowledge_edge_propose_nightly').then(
            (m) => m.buildKnowledgeEdgeProposeNightlyHandler,
          ),
      },
      {
        // YUK-349 B3 PR-2：empty-frontier prerequisite bootstrap（BJT 05:15，compose
        // 跑 05:30 之前，错峰）。learnableFrontier 空时 propose-only 低置信 prereq 边，
        // 破解冷启「没 prereq 边 → 前沿空 → 不知道先教什么」死锁。graph-topology 生产者，
        // 与 knowledge_edge_propose_nightly 同包同域。
        name: 'frontier_fill_nightly',
        schedule: { cron: '15 5 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/frontier_fill_nightly').then((m) => m.buildFrontierFillNightlyHandler),
      },
      {
        // YUK-48：KnowledgeReviewTask maintenance producer（BJT 03:00，多步 agent 档）。
        name: 'knowledge_maintenance_nightly',
        schedule: { cron: '0 3 * * *', tz: 'Asia/Shanghai' },
        queue: 'agent',
        load: () =>
          import('./jobs/knowledge_maintenance_nightly').then(
            (m) => m.buildKnowledgeMaintenanceNightlyHandler,
          ),
      },
      {
        // Task #16：async 错因归因。链式/按需（mistakes + ingestion import 投递），无 cron。
        name: 'attribution_followup',
        queue: 'llm',
        load: () =>
          import('./jobs/attribution_followup').then((m) => m.buildAttributionFollowupHandler),
      },
      {
        // P5 (YUK-489): dedup-on-maintenance. Deterministic (zero-LLM) nightly scan
        // for near-duplicate auto-created KC pairs by pgvector cosine distance →
        // emits MERGE PROPOSALS (pending inbox items). PROPOSE-ONLY: it NEVER calls
        // applyMerge (a merge is destructive — archives the from-KC, rewrites
        // knowledge_ids attribution + merged_from[]; stays behind the human accept
        // gate). cron 02:00 Asia/Shanghai — BEFORE knowledge_edge_propose 02:30 +
        // knowledge_maintenance 03:00, so the night's merge proposals are already in
        // the inbox when those run. queue 'llm': matches the pure-derivation sibling
        // answer_class_backfill (also declared 'llm') and every other nightly
        // backfill — even though the scan makes NO model call, the 'llm' tier is the
        // family's shared DLQ/retry bucket; 'fast' would skip the DLQ (a dropped run
        // would just wait for the next cron, but the merge-propose write deserves DLQ
        // retry coverage like its siblings). Auto-mounted by register-capability-jobs.
        name: 'kc_dedup_nightly',
        schedule: { cron: '0 2 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () => import('./jobs/kc_dedup_nightly').then((m) => m.buildKcDedupNightlyHandler),
      },
    ],
  },
  // M4-T4 (YUK-319)：proposal kind 归属声明。knowledge_node / knowledge_mutation 的
  // accept 委托 ./server/proposals（M3 起）；knowledge_edge 的决策器
  // decideKnowledgeEdgeProposal 仍在壳层（写 knowledge_edge 行 + 链式 event，
  // plan 裁决 T4 只补声明不迁体）；archive 按 producer 域归属本包
  // （./server/review.ts 在产），无 accept applier——壳层 default throw 注 YUK-44。
  proposals: {
    kinds: [
      { kind: 'knowledge_node' },
      { kind: 'knowledge_mutation' },
      { kind: 'knowledge_edge' },
      { kind: 'archive' },
    ],
  },
  // M5-T3 (YUK-321) — copilot 工具归属声明（图谱读 4 + 知识提议写 2）。
  copilotTools: {
    tools: [
      {
        name: 'query_knowledge',
        load: () => import('@/server/ai/tools/knowledge-readers').then((m) => m.queryKnowledgeTool),
      },
      {
        name: 'get_subject_graph_overview',
        load: () =>
          import('@/server/ai/tools/knowledge-readers').then((m) => m.getSubjectGraphOverviewTool),
      },
      {
        name: 'expand_knowledge_subgraph',
        load: () =>
          import('@/server/ai/tools/knowledge-readers').then((m) => m.expandKnowledgeSubgraphTool),
      },
      {
        name: 'find_knowledge_paths',
        load: () =>
          import('@/server/ai/tools/knowledge-readers').then((m) => m.findKnowledgePathsTool),
      },
      {
        name: 'propose_knowledge_edge',
        load: () =>
          import('@/server/ai/tools/proposal-tools').then((m) => m.proposeKnowledgeEdgeTool),
      },
      {
        name: 'propose_knowledge_mutation',
        load: () =>
          import('@/server/ai/tools/proposal-tools').then((m) => m.proposeKnowledgeMutationTool),
      },
    ],
  },
});
