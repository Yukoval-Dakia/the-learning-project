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
  KnowledgeTreeQuerySchema,
  KnowledgeTreeResponseSchema,
  LegacyKnowledgeEdgeDecisionBodySchema,
  LegacyKnowledgeEdgeDecisionResponseSchema,
  LegacyKnowledgeProposalDecisionBodySchema,
  LegacyKnowledgeProposalDecisionResponseSchema,
  LegacyKnowledgeProposalListResponseSchema,
  LegacyKnowledgeProposalQuerySchema,
} from '@/capabilities/knowledge/api/contracts';
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';
import { uiPagesFor } from '@/kernel/ui-surfaces';

export const knowledgeCapability = defineCapability({
  name: 'knowledge',
  description:
    '知识域：认知结构树（tree 快照 / effective_domain 派生轴——科目是视角不是结构）、' +
    'knowledge_edge 关系网、节点页聚合（node-page，跨包读 notes 导出）、提议双链' +
    '（节点 propose / 边 propose + rubric 校验 + accept/dismiss）。',
  api: {
    // Static segments match before the :id catch-all, so their order here is not
    // load-bearing for Hono.
    routes: [
      {
        method: 'GET',
        path: '/api/knowledge',
        operationId: 'getKnowledgeTreeSnapshot',
        request: { query: KnowledgeTreeQuerySchema },
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
        // Static segment; must not be captured by the :id route.
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
        // Four segments, so it cannot collide with the three-segment routes.
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
    ],
  },
  jobs: {
    handlers: [
      {
        // Propose-only bootstrap for an empty frontier.
        name: 'frontier_fill_nightly',
        dependsOn: [],
        eligibility: nightlyEligibility('structure', { respectPendingCap: true }),
        queue: 'llm',
        load: () =>
          import('./jobs/frontier_fill_nightly').then((m) => m.buildFrontierFillNightlyHandler),
      },
      {
        // Multi-step maintenance producer and the nightly mesh-edge proposer: it reads the
        // whole tree plus recent failures and proposes edges via propose_knowledge_edge.
        // No real upstream, which is why it is a root.
        name: 'knowledge_maintenance_nightly',
        dependsOn: [],
        eligibility: nightlyEligibility('structure'),
        queue: 'agent',
        load: () =>
          import('./jobs/knowledge_maintenance_nightly').then(
            (m) => m.buildKnowledgeMaintenanceNightlyHandler,
          ),
      },
      {
        // Deterministic near-duplicate scan that only proposes merges; accepting stays
        // with a human because applyMerge is destructive. It hard-depends on
        // embed_backfill, since pairs need embeddings.
        name: 'kc_dedup_nightly',
        dependsOn: ['embed_backfill'],
        eligibility: nightlyEligibility('hygiene_dedup'),
        queue: 'llm',
        load: () => import('./jobs/kc_dedup_nightly').then((m) => m.buildKcDedupNightlyHandler),
      },
      {
        // Low-frequency safety net for the residual grading race that accept-time
        // locking cannot close. It censuses, then repairs drifted ids through the accept
        // path's own idempotent function, capped per run. It never merges or archives.
        name: 'merge_attribution_sweep',
        schedule: { cron: '0 4 * * 1', tz: 'Asia/Shanghai' },
        eligibility: nightlyEligibility('deterministic'),
        queue: 'llm',
        load: () =>
          import('./jobs/merge_attribution_sweep').then((m) => m.buildMergeAttributionSweepHandler),
      },
      {
        // Report-only projection drift audit. It never writes an entity table or repairs:
        // an automatic projection fix would silently flip the source of truth.
        name: 'projection_oracle_sweep',
        schedule: { cron: '30 4 * * 1', tz: 'Asia/Shanghai' },
        eligibility: nightlyEligibility('deterministic'),
        queue: 'llm',
        load: () =>
          import('./jobs/projection_oracle_sweep').then((m) => m.buildProjectionOracleSweepHandler),
      },
    ],
  },
  // Proposal kinds owned here. `archive` is produced by this package and has no
  // applier; the shell's default throws for it.
  proposals: {
    kinds: [
      {
        kind: 'knowledge_node',
        accept: {
          load: () =>
            import('./server/proposal-appliers').then((m) => m.knowledgeNodeProposalAcceptApplier),
        },
        dismiss: {
          load: () =>
            import('./server/proposal-appliers').then(
              (module) => module.knowledgeNodeProposalDismissApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/proposal-appliers').then(
              (module) => module.knowledgeNodeProposalRetractApplier,
            ),
        },
      },
      {
        kind: 'knowledge_mutation',
        accept: {
          load: () =>
            import('./server/proposal-appliers').then(
              (m) => m.knowledgeMutationProposalAcceptApplier,
            ),
        },
        // Same applier as knowledge_node: dismiss must take accept's proposal row lock.
        dismiss: {
          load: () =>
            import('./server/proposal-appliers').then(
              (module) => module.knowledgeNodeProposalDismissApplier,
            ),
        },
      },
      {
        kind: 'knowledge_edge',
        accept: {
          load: () =>
            import('./server/proposal-appliers').then(
              (module) => module.knowledgeEdgeProposalAcceptApplier,
            ),
        },
        dismiss: {
          load: () =>
            import('./server/proposal-appliers').then(
              (module) => module.knowledgeEdgeProposalDismissApplier,
            ),
        },
      },
      { kind: 'archive' },
    ],
  },
  copilotTools: {
    tools: [
      {
        name: 'query_knowledge',
        load: () => import('./server/tools/knowledge-readers').then((m) => m.queryKnowledgeTool),
      },
      {
        name: 'get_knowledge_state',
        load: () => import('./server/tools/knowledge-state').then((m) => m.getKnowledgeStateTool),
      },
      {
        name: 'get_subject_graph_overview',
        load: () =>
          import('./server/tools/knowledge-readers').then((m) => m.getSubjectGraphOverviewTool),
      },
      {
        name: 'expand_knowledge_subgraph',
        load: () =>
          import('./server/tools/knowledge-readers').then((m) => m.expandKnowledgeSubgraphTool),
      },
      {
        name: 'find_knowledge_paths',
        load: () =>
          import('./server/tools/knowledge-readers').then((m) => m.findKnowledgePathsTool),
      },
      {
        name: 'propose_knowledge_edge',
        load: () => import('./server/tools/proposal-tools').then((m) => m.proposeKnowledgeEdgeTool),
      },
      {
        name: 'propose_knowledge_mutation',
        load: () =>
          import('./server/tools/proposal-tools').then((m) => m.proposeKnowledgeMutationTool),
      },
    ],
  },
  ui: { pages: uiPagesFor('knowledge') },
});
