import { z } from 'zod';
import { ProposalDecisionInput } from '@/core/schema/proposal';
import { API_ERROR_RESPONSES, ApiIdParamsSchema } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import {
  AutoAppliedProposalDigestSchema,
  OvernightDigestResponseSchema,
  PrepDeskConjecturesResponseSchema,
  PrepDeskProbesResponseSchema,
  ProposalDecisionResponseSchema,
  ProposalPageResponseSchema,
  SubjectListResponseSchema,
  TeachingBriefAckBodySchema,
  TeachingBriefAckResponseSchema,
  TeachingBriefInteractionBodySchema,
  TeachingBriefInteractionResponseSchema,
  TeachingBriefResponseSchema,
  WorkbenchSummaryResponseSchema,
} from './api/contracts';

// Cross-domain workbench shell: proposal inbox plus workbench aggregates.
export const shellCapability = defineCapability({
  name: 'shell',
  description:
    '工作台壳层：跨域提议收件箱（统一 /api/proposals 列表 + decide/retract 决策面，' +
    '17 kind 全量）与工作台聚合（/api/workbench/summary——提议 KPI / due / 待归因 / ' +
    '知识量 / 进行中会话 / 7 天活动热力；spec M4 验收「夜间跑完，早上工作台有交班条' +
    '与待审提议」的读模型）。',
  api: {
    routes: [
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
          200: ProposalPageResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 200, maxLimit: 500 },
        load: () => import('./api/proposals-list').then((m) => m.GET),
      },
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
          200: ProposalDecisionResponseSchema,
          201: ProposalDecisionResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () => import('./api/proposal-decisions').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/workbench/summary',
        operationId: 'getWorkbenchSummary',
        responses: { 200: WorkbenchSummaryResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/workbench-summary').then((m) => m.GET),
      },
      // Read-only digest; a quiet night is an explicit state, not a missing value.
      {
        method: 'GET',
        path: '/api/workbench/overnight-digest',
        operationId: 'getOvernightDigest',
        responses: { 200: OvernightDigestResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/overnight-digest').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/prep-desk/conjectures',
        operationId: 'listPrepDeskConjectures',
        responses: { 200: PrepDeskConjecturesResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/prep-desk-conjectures').then((m) => m.GET),
      },
      // Calibration numbers never cross this wire; answering goes through
      // /api/conjecture/probe/[id]/answer.
      {
        method: 'GET',
        path: '/api/prep-desk/probes',
        operationId: 'listPrepDeskProbes',
        responses: { 200: PrepDeskProbesResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/prep-desk-probes').then((m) => m.GET),
      },
      // Projects one preferred outcome > active probe > fresh finding; never
      // exposes calibration.
      {
        method: 'GET',
        path: '/api/prep-desk/brief',
        operationId: 'getTeachingBrief',
        responses: { 200: TeachingBriefResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/prep-desk-brief').then((m) => m.GET),
      },
      // Retires a delivered outcome from brief eligibility; writes no derived
      // status back onto proposal/question/result.
      {
        method: 'POST',
        path: '/api/prep-desk/brief/ack',
        operationId: 'acknowledgeTeachingBrief',
        request: { body: TeachingBriefAckBodySchema },
        responses: {
          200: TeachingBriefAckResponseSchema,
          201: TeachingBriefAckResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () => import('./api/teaching-brief-ack').then((m) => m.POST),
      },
      // Funnel signals for the survival report; no derived status is written back,
      // and the rows opt out of mem0.
      {
        method: 'POST',
        path: '/api/prep-desk/brief/interaction',
        operationId: 'recordTeachingBriefInteraction',
        request: { body: TeachingBriefInteractionBodySchema },
        responses: {
          200: TeachingBriefInteractionResponseSchema,
          201: TeachingBriefInteractionResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () => import('./api/teaching-brief-interaction').then((m) => m.POST),
      },
    ],
  },
  ui: { pages: uiPagesFor('shell') },
});
