// 整卷与做题会话 owner 的 manifest 片段，由根 `manifest.ts` 组合。
import {
  API_ERROR_RESPONSES,
  ApiIdParamsSchema,
  BinaryResponseSchema,
  CursorQuerySchema,
} from '@/kernel/http-contracts';
import type { CapabilityManifest } from '@/kernel/manifest';
import {
  CreateReviewSessionBody,
  ReviewSessionCreatedSchema,
  ReviewSessionSchema,
  ReviewSessionTransitionSchema,
  UpdateReviewSessionBody,
} from '../api/contracts';
import {
  CreatePaperAnswerDraftBodySchema,
  CreatePaperSubmissionBodySchema,
  PaperAnswerDraftCreatedSchema,
  PaperAnswerDraftParamsSchema,
  PaperAnswerDraftSchema,
  PaperDetailResponseSchema,
  PaperListResponseSchema,
  PaperParamsSchema,
  PaperSubmissionResponseSchema,
} from '../api/paper-contracts';
import {
  WorksheetExportCreateBodySchema,
  WorksheetExportStateSchema,
  WorksheetPageParamsSchema,
  WorksheetPageResponseSchema,
  WorksheetRegionMapArchiveBody,
  WorksheetRegionMapArchivedSchema,
  WorksheetTokenParamsSchema,
} from '../api/worksheet-contracts';
import { WORKSHEET_RENDER_QUEUE } from './jobs/worksheet-render-queue';

export const sessionManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
  events: {
    actions: ['experimental:assessment_feedback_released'],
  },
  api: {
    routes: [
      {
        method: 'POST',
        path: '/api/review-sessions',
        operationId: 'createReviewSession',
        request: { body: CreateReviewSessionBody },
        responses: {
          200: ReviewSessionCreatedSchema,
          201: ReviewSessionCreatedSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () => import('./api/review-sessions').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/review-sessions/[id]',
        operationId: 'getReviewSession',
        request: { params: ApiIdParamsSchema },
        responses: { 200: ReviewSessionSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/review-session-detail').then((m) => m.GET),
      },
      {
        method: 'PATCH',
        path: '/api/review-sessions/[id]',
        operationId: 'updateReviewSession',
        request: { params: ApiIdParamsSchema, body: UpdateReviewSessionBody },
        responses: { 200: ReviewSessionTransitionSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/review-session-detail').then((m) => m.PATCH),
      },
      {
        method: 'POST',
        path: '/api/review-sessions/[id]/answer-drafts',
        operationId: 'createPaperAnswerDraft',
        request: { params: ApiIdParamsSchema, body: CreatePaperAnswerDraftBodySchema },
        responses: {
          200: PaperAnswerDraftCreatedSchema,
          201: PaperAnswerDraftCreatedSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () => import('../api/resource-routes').then((m) => m.createPaperAnswerDraftResource),
      },
      {
        method: 'GET',
        path: '/api/review-sessions/[id]/answer-drafts/[answerId]',
        operationId: 'getPaperAnswerDraft',
        request: { params: PaperAnswerDraftParamsSchema },
        responses: { 200: PaperAnswerDraftSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/paper-answer-route').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review-sessions/[id]/submissions',
        operationId: 'createPaperSubmission',
        request: { params: ApiIdParamsSchema, body: CreatePaperSubmissionBodySchema },
        responses: { 201: PaperSubmissionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('../api/resource-routes').then((m) => m.createPaperSubmissionResource),
      },
      {
        method: 'GET',
        path: '/api/papers',
        operationId: 'listPapers',
        request: { query: CursorQuerySchema },
        responses: {
          200: PaperListResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 50, maxLimit: 200 },
        load: () => import('./api/papers-list').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/papers/[id]',
        operationId: 'getPaper',
        request: { params: ApiIdParamsSchema },
        responses: {
          200: PaperDetailResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        load: () => import('./api/paper-detail-route').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/practice/[id]',
        operationId: 'getPaperLegacy',
        request: { params: PaperParamsSchema },
        responses: { 200: PaperDetailResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/papers/[id]', since: '@1783987200' },
        load: () => import('./api/legacy-paper-detail').then((m) => m.GET),
      },
      // YUK-1523（P5）— 作答卷 PDF 导出。导出 = 逐题经既有 issueAssessment 发放
      //（G4 门只放可判题，拒掉的题随响应返回 typed 原因）；token/短码是页面
      // 身份码 tlp://ws/v1/<token>/<页>/<总页> 的锚；同 idempotency_key 重放不重发。
      {
        method: 'POST',
        path: '/api/worksheet-exports',
        operationId: 'createWorksheetExport',
        request: { body: WorksheetExportCreateBodySchema },
        responses: {
          200: WorksheetExportStateSchema,
          201: WorksheetExportStateSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () =>
          import('./api/worksheet-export-route').then((m) => m.createWorksheetExportRoute),
      },
      {
        // 渲染器恢复/总览读面（token 不可猜；无私有答案）。
        method: 'GET',
        path: '/api/worksheet-exports/[token]',
        operationId: 'getWorksheetExport',
        request: { params: WorksheetTokenParamsSchema },
        responses: { 200: WorksheetExportStateSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/worksheet-export-route').then((m) => m.getWorksheetExportRoute),
      },
      {
        // 区域图存档：界面线与 PDF 同一渲染 pass 量出的区域图 POST 回后端，
        // 对冻结发放校验后按页 write-once 存档（同图重 POST 幂等）。
        method: 'POST',
        path: '/api/worksheet-exports/[token]/region-map',
        operationId: 'archiveWorksheetRegionMap',
        request: {
          params: WorksheetTokenParamsSchema,
          body: WorksheetRegionMapArchiveBody,
        },
        responses: {
          200: WorksheetRegionMapArchivedSchema,
          201: WorksheetRegionMapArchivedSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () =>
          import('./api/worksheet-export-route').then((m) => m.archiveWorksheetRegionMapRoute),
      },
      {
        // YUK-1529 — 已存档 PDF 下载（content-addressed R2 对象，不可变）。
        // 未渲染 / blob 缺失分开 404 如实上报。
        method: 'GET',
        path: '/api/worksheet-exports/[token]/pdf',
        operationId: 'getWorksheetExportPdf',
        request: { params: WorksheetTokenParamsSchema },
        responses: { 200: BinaryResponseSchema, ...API_ERROR_RESPONSES },
        responseMediaTypes: { 200: 'application/pdf' },
        successStatus: 200,
        load: () =>
          import('./api/worksheet-export-route').then((m) => m.getWorksheetExportPdfRoute),
      },
      {
        // P6 回读面：token + 页 → issuance id、该页冻结区域图与 part/slot 坐标。
        method: 'GET',
        path: '/api/worksheet-exports/[token]/pages/[page]',
        operationId: 'getWorksheetPage',
        request: { params: WorksheetPageParamsSchema },
        responses: { 200: WorksheetPageResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/worksheet-export-route').then((m) => m.getWorksheetPageRoute),
      },
    ],
  },
  jobs: {
    handlers: [
      {
        // YUK-1529 — 服务端作答卷渲染：无头 Chromium 开 /print/worksheet/<token>，
        // 同一 pass 量区域图 + page.pdf() → R2（content-addressed）→ #1773
        // write-once 存档。submitWorksheetExport 经创建 route 对 created/replayed 入队。
        // 'agent' 档：多步浏览器任务，DLQ + 重试兜瞬时失败；不调模型零成本。
        name: WORKSHEET_RENDER_QUEUE,
        queue: 'agent',
        load: () => import('./jobs/worksheet_render').then((m) => m.buildWorksheetRenderHandler),
      },
      // YUK-870 (F3.5b) — Phase 1d session_summary 注册自中央渐缩簿收编（等价
      // 平移红线：LLM 档 1h expire + DLQ、2s/1 worker 选项——与原中央行显式 opts
      // 相同；handler 实现已随 jobs/session_summary.ts 迁入本包；TaskSpec 归
      // practice owner map，中央 semantic quarry 至此零 transitional entry）。
      {
        name: 'session_summary',
        queue: 'llm',
        pollingIntervalSeconds: 2,
        batchSize: 1,
        load: () => import('./jobs/session_summary').then((m) => m.buildSessionSummaryHandler),
      },
    ],
  },
  copilotTools: {
    tools: [
      {
        name: 'write_quiz',
        load: () => import('./tools/write-quiz').then((m) => m.writeQuizTool),
      },
    ],
  },
};
