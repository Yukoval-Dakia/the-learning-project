import { ProposalDecisionInput } from '@/core/schema/proposal';
import {
  API_ERROR_RESPONSES,
  ApiIdParamsSchema,
  collectionResponseSchema,
} from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import { z } from 'zod';
import {
  AutoAppliedProposalDigestSchema,
  LegacyProposalDecisionBodySchema,
  LegacyProposalDecisionResponseSchema,
  LegacyProposalRetractBodySchema,
  LegacyProposalRetractResponseSchema,
  OvernightDigestResponseSchema,
  PrepDeskConjecturesResponseSchema,
  PrepDeskProbesResponseSchema,
  SubjectListResponseSchema,
  TeachingBriefAckBodySchema,
  TeachingBriefAckResponseSchema,
  TeachingBriefResponseSchema,
  WorkbenchSummaryResponseSchema,
} from './api/contracts';

// M4-T5 (YUK-319/YUK-318)：shell 包——跨域工作台壳层。提议收件箱三路由源自
// 旧 Next app/api/proposals/* 等价平移（accept+dismiss 合并为单 decide 端点，
// kind query 是 YUK-318 收口增量）；workbench/summary 是 today 重生聚合
// （新端点，不受搬迁红线约束）。
export const shellCapability = defineCapability({
  name: 'shell',
  description:
    '工作台壳层：跨域提议收件箱（统一 /api/proposals 列表 + decide/retract 决策面，' +
    '17 kind 全量）与工作台聚合（/api/workbench/summary——提议 KPI / due / 待归因 / ' +
    '知识量 / 进行中会话 / 7 天活动热力；spec M4 验收「夜间跑完，早上工作台有交班条' +
    '与待审提议」的读模型）。',
  api: {
    routes: [
      // YUK-598 — learner 面 selectable 科目视图（SPA useSubjects() 数据源；
      // custom 科目经 YUK-599 水合后自动进列）。字段合同见 handler 头注释。
      {
        method: 'GET',
        path: '/api/subjects',
        operationId: 'listSubjects',
        responses: { 200: SubjectListResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/subjects-list').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/proposals',
        operationId: 'listProposals',
        request: {
          query: z.object({
            status: z.string().optional(),
            kind: z.string().optional(),
            limit: z.coerce.number().int().positive().optional(),
            cursor: z.string().min(1).optional(),
          }),
        },
        responses: {
          200: collectionResponseSchema(z.object({ id: z.string() }).passthrough()),
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 200, maxLimit: 500 },
        load: () => import('./api/proposals-list').then((m) => m.GET),
      },
      // YUK-521 (A4 强度轴) — A 档 auto-applied 卡 + 当前裁决熔断快照只读读模型。
      // 静态路径，与 /api/proposals/[id]/{decide,retract} 不冲突（不同段深）。
      {
        method: 'GET',
        path: '/api/proposals/auto-applied',
        operationId: 'getAutoAppliedProposals',
        responses: { 200: AutoAppliedProposalDigestSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/proposals-auto-applied').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/proposals/[id]/decisions',
        operationId: 'createProposalDecision',
        request: { params: ApiIdParamsSchema, body: ProposalDecisionInput },
        responses: {
          200: z.object({ decision_event_id: z.string(), created: z.boolean() }).passthrough(),
          201: z.object({ decision_event_id: z.string(), created: z.boolean() }).passthrough(),
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () => import('./api/proposal-decisions').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/proposals/[id]/decide',
        operationId: 'decideProposalLegacy',
        request: { params: ApiIdParamsSchema, body: LegacyProposalDecisionBodySchema },
        responses: { 200: LegacyProposalDecisionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: {
          successor: '/api/proposals/[id]/decisions',
          since: '@1783987200',
        },
        load: () => import('./api/proposal-decide').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/proposals/[id]/retract',
        operationId: 'retractProposalLegacy',
        request: { params: ApiIdParamsSchema, body: LegacyProposalRetractBodySchema },
        responses: { 200: LegacyProposalRetractResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: {
          successor: '/api/proposals/[id]/decisions',
          since: '@1783987200',
        },
        load: () => import('./api/proposal-retract').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/workbench/summary',
        operationId: 'getWorkbenchSummary',
        responses: { 200: WorkbenchSummaryResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/workbench-summary').then((m) => m.GET),
      },
      // YUK-520 (A1 夜窗 digest) — 昨夜窗 digest 只读读模型（5 夜间事实源聚合 +
      // has_overnight_activity 空夜显式信号）。供 /today 最小交班缕消费。
      {
        method: 'GET',
        path: '/api/workbench/overnight-digest',
        operationId: 'getOvernightDigest',
        responses: { 200: OvernightDigestResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/overnight-digest').then((m) => m.GET),
      },
      // YUK-406 / YUK-440 (教研团 Phase 0 / U4 备课台) — top ≤3 pending conjecture
      // 读模型（salience 排序，confidence 永不过线）。
      {
        method: 'GET',
        path: '/api/prep-desk/conjectures',
        operationId: 'listPrepDeskConjectures',
        responses: { 200: PrepDeskConjecturesResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/prep-desk-conjectures').then((m) => m.GET),
      },
      // YUK-567 slice-2 — 备课台「待你试做」队列：≤3 served-but-unanswered mind_probe
      // 读模型（anti-guilt 无校准数字）。作答走 /api/conjecture/probe/[id]/answer。
      {
        method: 'GET',
        path: '/api/prep-desk/probes',
        operationId: 'listPrepDeskProbes',
        responses: { 200: PrepDeskProbesResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/prep-desk-probes').then((m) => m.GET),
      },
      // YUK-706 (P0F/2) — unified, read-only TeachingBrief. Projects one globally
      // preferred outcome > active probe > fresh finding; never exposes calibration.
      {
        method: 'GET',
        path: '/api/prep-desk/brief',
        operationId: 'getTeachingBrief',
        responses: { 200: TeachingBriefResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/prep-desk-brief').then((m) => m.GET),
      },
      // YUK-708 (P0F/4) — append-only, idempotent outcome acknowledgement ("知道了").
      // Retires a delivered outcome from brief eligibility; writes NO derived status
      // back onto proposal/question/result (contract §4.2). Deeper path segment than
      // GET /api/prep-desk/brief, so the two do not collide.
      {
        method: 'POST',
        path: '/api/prep-desk/brief/ack',
        operationId: 'acknowledgeTeachingBrief',
        request: { body: TeachingBriefAckBodySchema },
        responses: { 200: TeachingBriefAckResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/teaching-brief-ack').then((m) => m.POST),
      },
    ],
  },
  ui: { pages: uiPagesFor('shell') },
});
