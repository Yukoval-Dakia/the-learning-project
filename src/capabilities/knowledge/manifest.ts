import {
  CreateKnowledgeEdgeBodySchema,
  CreateKnowledgeEdgeResponseSchema,
  KnowledgeEdgeCollectionResponseSchema,
  KnowledgeEdgeQuerySchema,
  KnowledgeEdgeSchema,
  KnowledgeFrontierResponseSchema,
  KnowledgeIdParamsSchema,
  KnowledgeMisconceptionListResponseSchema,
  KnowledgeNodePageResponseSchema,
  KnowledgeReviewDueSummaryResponseSchema,
  KnowledgeTreeResponseSchema,
  LegacyKnowledgeEdgeDecisionBodySchema,
  LegacyKnowledgeEdgeDecisionResponseSchema,
  LegacyKnowledgeMisconceptionVetoResponseSchema,
  LegacyKnowledgeProposalDecisionBodySchema,
  LegacyKnowledgeProposalDecisionResponseSchema,
  LegacyKnowledgeProposalListResponseSchema,
  LegacyKnowledgeProposalQuerySchema,
} from '@/capabilities/knowledge/api/contracts';
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';

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
        operationId: 'getKnowledgeTreeSnapshot',
        responses: { 200: KnowledgeTreeResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/tree').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/knowledge/proposals',
        operationId: 'listKnowledgeProposalsLegacy',
        request: { query: LegacyKnowledgeProposalQuerySchema },
        responses: { 200: LegacyKnowledgeProposalListResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/proposals-list').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/knowledge/proposals/[id]',
        operationId: 'decideKnowledgeProposalLegacy',
        request: {
          params: KnowledgeIdParamsSchema,
          body: LegacyKnowledgeProposalDecisionBodySchema,
        },
        responses: {
          200: LegacyKnowledgeProposalDecisionResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        deprecation: {
          since: '@1783987200',
          successor: '/api/proposals/[id]/decisions',
        },
        load: () => import('./api/proposal-decide').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/knowledge/edges',
        operationId: 'listKnowledgeEdges',
        request: { query: KnowledgeEdgeQuerySchema },
        responses: { 200: KnowledgeEdgeCollectionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 500, maxLimit: 500 },
        load: () => import('./api/edges').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/knowledge/edges',
        operationId: 'createKnowledgeEdge',
        request: { body: CreateKnowledgeEdgeBodySchema },
        responses: { 201: CreateKnowledgeEdgeResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/edges').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/knowledge/edges/[id]',
        operationId: 'getKnowledgeEdge',
        request: { params: KnowledgeIdParamsSchema },
        responses: { 200: KnowledgeEdgeSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/edges').then((m) => m.getEdge),
      },
      {
        method: 'POST',
        path: '/api/knowledge/edges/proposals/[id]',
        operationId: 'decideKnowledgeEdgeProposalLegacy',
        request: {
          params: KnowledgeIdParamsSchema,
          body: LegacyKnowledgeEdgeDecisionBodySchema,
        },
        responses: {
          200: LegacyKnowledgeEdgeDecisionResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        deprecation: {
          since: '@1783987200',
          successor: '/api/proposals/[id]/decisions',
        },
        load: () => import('./api/edge-proposal-decide').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/knowledge/review-due-summary',
        operationId: 'getKnowledgeReviewDueSummary',
        responses: {
          200: KnowledgeReviewDueSummaryResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/review-due-summary').then((m) => m.GET),
      },
      {
        // A5 S2 (YUK-354)：FrontierRail 读模型（learnable_frontier 横幅）。静态段，
        // 须在 :id catch-all 之前匹配（同 proposals/edges/review*）。
        method: 'GET',
        path: '/api/knowledge/frontier',
        operationId: 'listKnowledgeFrontier',
        responses: { 200: KnowledgeFrontierResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/frontier').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/knowledge/[id]',
        operationId: 'getKnowledgeNode',
        request: { params: KnowledgeIdParamsSchema },
        responses: { 200: KnowledgeNodePageResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/node-page-route').then((m) => m.GET),
      },
      {
        // A5 S4 (YUK-531)：per-KC 误区 funnel 读模型（「指向此点的误区」）。4 段路径
        // （:id/misconceptions），与 frontier(3 段)/[id](3 段) 无段数碰撞，顺序无关。
        method: 'GET',
        path: '/api/knowledge/[id]/misconceptions',
        operationId: 'listKnowledgeNodeMisconceptions',
        request: { params: KnowledgeIdParamsSchema },
        responses: {
          200: KnowledgeMisconceptionListResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/misconceptions').then((m) => m.GET),
      },
      {
        // A5 S4 (YUK-531 PR-5)：candidate(猜想/候选) 误区 veto = dismiss pending conjecture。
        // 静态段 misconceptions 在前（5 段 POST），与 [id]/misconceptions(GET) 方法+段序均不碰，
        // 与 proposals/edges 同样静态优先。Option A：仅 candidate 段 live，confirmed archive 延后。
        method: 'POST',
        path: '/api/knowledge/misconceptions/[id]/veto',
        operationId: 'vetoKnowledgeMisconceptionLegacy',
        request: { params: KnowledgeIdParamsSchema },
        responses: {
          200: LegacyKnowledgeMisconceptionVetoResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        deprecation: {
          since: '@1783987200',
          successor: '/api/proposals/[id]/decisions',
        },
        load: () => import('./api/misconception-veto').then((m) => m.POST),
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
        // applyMerge (a merge is destructive — archives the from-KC, sets merged_from[],
        // and repairs the downstream attribution surfaces — YUK-543; stays behind the
        // human accept gate). cron 05:05 Asia/Shanghai — AFTER embed_backfill 04:40
        // (YUK-377 复审 §3.3): the pair scan hard-gates `embedding IS NOT NULL`, and a KC
        // minted during the day only gets its vector at the 04:40 embed pass, so the old
        // 02:00 slot made every new KC wait one extra night before its first dedup scan.
        // Accepted trade-off: same-night edge_propose 02:30 / maintenance 03:00 no longer
        // see tonight's merge proposals in the inbox — neither consumes them
        // programmatically (grep-verified 2026-07-06); pending proposals persist, so the
        // agent context picks them up the next night. queue 'llm': matches the pure-derivation sibling
        // answer_class_backfill (also declared 'llm') and every other nightly
        // backfill — even though the scan makes NO model call, the 'llm' tier is the
        // family's shared DLQ/retry bucket; 'fast' would skip the DLQ (a dropped run
        // would just wait for the next cron, but the merge-propose write deserves DLQ
        // retry coverage like its siblings). Auto-mounted by register-capability-jobs.
        name: 'kc_dedup_nightly',
        schedule: { cron: '5 5 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () => import('./jobs/kc_dedup_nightly').then((m) => m.buildKcDedupNightlyHandler),
      },
      {
        // YUK-543/YUK-544: merge-attribution sweep — census report + BOUNDED AUTO-REPAIR. Low-frequency
        // safety net for the residual async-grading race that applyMerge's in-tx locking narrows but
        // cannot fully close (a stale pre-merge grading upsert can re-orphan a mastery/fsrs row keyed
        // to a merged-away KC). Phase 1 censuses + reports the counts (YUK-543 shape preserved);
        // phase 2 (YUK-544, spec Appendix C D-C) auto-invokes the SAME idempotent
        // repairMergeAttributionForFromId the accept path uses on the drifted subset — never raw table
        // writes, never merges/archives a KC itself — bounded by a per-run hard cap (leftover defers to
        // next run), with a forensic `experimental:merge_attribution_repaired` event per repaired
        // from_id and a post-repair zero re-census. Weekly (Mon 04:00 Asia/Shanghai — off the nightly
        // cluster). queue 'llm': now that the sweep WRITES (repairs + audit events), it joins the
        // backfill family's shared DLQ/retry bucket like kc_dedup_nightly above ('fast' would skip the
        // DLQ, and a repair write deserves DLQ retry coverage like its siblings). Auto-mounted.
        name: 'merge_attribution_sweep',
        schedule: { cron: '0 4 * * 1', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/merge_attribution_sweep').then((m) => m.buildMergeAttributionSweepHandler),
      },
      {
        // YUK-548 (worklist #5, Q4a): projection-drift oracle — weekly REPORT-ONLY sweep over the ON
        // projection entities (symmetric anchor-gated audit: FIELD_DRIFT + GHOST/MISSING). Detects
        // out-of-band writes + rowset existence anomalies; NEVER writes an entity table, NEVER
        // auto-repairs (a projection auto-fix = a silent local SoT flip — red line). Weekly (Mon 04:30
        // Asia/Shanghai — 30min after merge_attribution_sweep). queue 'llm': it WRITES a fold-inert
        // forensic breadcrumb, so it joins the DLQ/retry bucket like its siblings ('fast' skips the
        // DLQ → a dropped run = a silent week-long evidence blind spot). Auto-mounted.
        name: 'projection_oracle_sweep',
        schedule: { cron: '30 4 * * 1', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/projection_oracle_sweep').then((m) => m.buildProjectionOracleSweepHandler),
      },
      {
        // YUK-559 (S3, worklist #6): kg-borrowing SHADOW sweep — weekly REPORT-ONLY,
        // FLAG-INDEPENDENT shadow of the A5/A6 soft layer. Re-runs the SAME pure math the
        // live path would (smoothThetaByComponent / propagatePrereq) over live mastery_state +
        // related_to/prerequisite/derived_from edges WITHOUT the dark flag check, and emits ONE
        // summary event (experimental:kg_borrow_shadow, ingest_at=now opt-out) carrying the
        // flip's move/borrow/component-size distribution — so the owner gets data DURING dark
        // (data门只 gate 翻转不 gate build; breaks the "wait for data to flip" dead loop).
        // Weekly Mon 05:00 Asia/Shanghai — offset from projection_oracle_sweep (04:30) +
        // merge_attribution_sweep (04:00), before the daily frontier_fill (05:15). queue 'llm':
        // WRITES an evidence event, joining the backfill DLQ/retry family like its siblings
        // (the runner self-swallows, so a failed run logs but never DLQ-thrashes). Auto-mounted.
        name: 'kg_borrow_shadow_sweep',
        schedule: { cron: '0 5 * * 1', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/kg_borrow_shadow_sweep').then((m) => m.buildKgBorrowShadowSweepHandler),
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
      {
        kind: 'knowledge_node',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (m) => m.knowledgeNodeProposalAcceptApplier,
            ),
        },
      },
      {
        kind: 'knowledge_mutation',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (m) => m.knowledgeMutationProposalAcceptApplier,
            ),
        },
      },
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
  ui: { pages: uiPagesFor('knowledge') },
});
