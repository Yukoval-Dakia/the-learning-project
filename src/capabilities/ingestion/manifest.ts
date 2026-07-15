import {
  API_ERROR_RESPONSES,
  ApiErrorResponseSchema,
  ApiIdParamsSchema,
  CursorQuerySchema,
  collectionResponseSchema,
} from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import {
  CreateIngestionSessionBody,
  DocxIngestionResponseSchema,
  IngestionBlocksResponseSchema,
  IngestionEventStreamResponseSchema,
  IngestionEventsHeadersSchema,
  IngestionOperationSchema,
  IngestionSessionResponseSchema,
  IngestionSessionSchema,
  LegacyExtractionResponseSchema,
  LegacyImportResponseSchema,
  LegacyMakePaperResponseSchema,
  LegacyRescueResponseSchema,
  MultipartFileUploadSchema,
  PdfExpansionResponseSchema,
  RevertAutoEnrolledBlockBodySchema,
  RevertAutoEnrolledBlockResponseSchema,
} from './api/contracts';
import { ImportBody } from './api/import-schema';
import { IngestionOperationRequest, MakePaperBody, RescueBody } from './api/operation-schema';

export const ingestionCapability = defineCapability({
  name: 'ingestion',
  description:
    '录入：任何题目进系统的通道（拍照/PDF/DOCX/手输 → 原图留存 → OCR/VLM 三层提取 → 切块 → 标注 → 入库）。错题是题目的标记不是通道（D11）。',
  api: {
    // M1-T4 (YUK-314)：所有 route 声明均带 load 懒加载 thunk（manifest 保持纯元数据，
    // unit 分区不拉 db）。[id] 段由
    // server/app.ts 的 toHonoPath 转为 :id 并把捕获参数透传 handler 第二实参。
    routes: [
      {
        method: 'GET',
        path: '/api/ingestion',
        operationId: 'listLegacyIngestionSessions',
        request: { query: CursorQuerySchema },
        responses: {
          200: collectionResponseSchema(IngestionSessionSchema),
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 20, maxLimit: 100 },
        deprecation: { successor: '/api/ingestion-sessions' },
        load: () => import('./api/sessions').then((m) => m.legacyListIngestionSessions),
      },
      {
        method: 'POST',
        path: '/api/ingestion',
        operationId: 'createLegacyIngestionSession',
        request: { body: CreateIngestionSessionBody },
        responses: { 200: IngestionSessionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/ingestion-sessions' },
        load: () => import('./api/sessions').then((m) => m.legacyCreateIngestionSession),
      },
      {
        method: 'GET',
        path: '/api/ingestion-sessions',
        operationId: 'listIngestionSessions',
        request: { query: CursorQuerySchema },
        responses: {
          200: collectionResponseSchema(IngestionSessionSchema),
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 20, maxLimit: 100 },
        load: () => import('./api/sessions').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/ingestion-sessions',
        operationId: 'createIngestionSession',
        request: { body: CreateIngestionSessionBody },
        responses: { 201: IngestionSessionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/sessions').then((m) => m.createIngestionSessionResource),
      },
      {
        method: 'GET',
        path: '/api/ingestion-sessions/[id]',
        operationId: 'getIngestionSession',
        request: { params: ApiIdParamsSchema },
        responses: { 200: IngestionSessionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/session-detail').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/ingestion/pdf',
        operationId: 'expandIngestionPdf',
        request: {
          body: MultipartFileUploadSchema,
          bodyMediaType: 'multipart/form-data',
        },
        responses: { 201: PdfExpansionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/pdf').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/docx',
        operationId: 'createIngestionFromDocx',
        request: {
          body: MultipartFileUploadSchema,
          bodyMediaType: 'multipart/form-data',
        },
        responses: { 201: DocxIngestionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/docx').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/ingestion/[id]/blocks',
        operationId: 'listIngestionSessionBlocks',
        request: { params: ApiIdParamsSchema },
        responses: { 200: IngestionBlocksResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/blocks').then((m) => m.GET),
      },
      {
        // SSE 首例：fetch + ReadableStream 消费端带标准 x-internal-token header
        // （src/ui/lib/sse.ts 从不使用 EventSource），token gate 无需任何豁免。
        method: 'GET',
        path: '/api/ingestion/[id]/events',
        operationId: 'streamIngestionSessionEvents',
        request: { params: ApiIdParamsSchema, headers: IngestionEventsHeadersSchema },
        responses: { 200: IngestionEventStreamResponseSchema, ...API_ERROR_RESPONSES },
        responseMediaTypes: { 200: 'text/event-stream' },
        successStatus: 200,
        load: () => import('./api/events').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/ingestion-sessions/[id]/operations',
        operationId: 'createIngestionOperation',
        request: { params: ApiIdParamsSchema, body: IngestionOperationRequest },
        responses: {
          200: IngestionOperationSchema,
          202: IngestionOperationSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 202],
        load: () => import('./api/operations').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/ingestion-operations/[id]',
        operationId: 'getIngestionOperation',
        request: { params: ApiIdParamsSchema },
        responses: { 200: IngestionOperationSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/operations').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/extract',
        operationId: 'extractLegacyIngestionSession',
        request: { params: ApiIdParamsSchema },
        responses: { 200: LegacyExtractionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/ingestion-sessions/[id]/operations' },
        load: () => import('./api/extract').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/import',
        operationId: 'importLegacyIngestionSession',
        request: { params: ApiIdParamsSchema, body: ImportBody },
        responses: { 200: LegacyImportResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/ingestion-sessions/[id]/operations' },
        load: () => import('./api/import').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/make-paper',
        operationId: 'createLegacyIngestionPaper',
        request: {
          params: ApiIdParamsSchema,
          body: MakePaperBody,
          bodyRequired: false,
        },
        responses: { 200: LegacyMakePaperResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/ingestion-sessions/[id]/operations' },
        load: () => import('./api/make-paper').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/rescue',
        operationId: 'rescueLegacyIngestionBlock',
        request: { params: ApiIdParamsSchema, body: RescueBody },
        responses: {
          200: LegacyRescueResponseSchema,
          501: ApiErrorResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        deprecation: { successor: '/api/ingestion-sessions/[id]/operations' },
        load: () => import('./api/rescue').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/ingestion/[id]/revert',
        operationId: 'revertAutoEnrolledIngestionBlock',
        request: { params: ApiIdParamsSchema, body: RevertAutoEnrolledBlockBodySchema },
        responses: { 200: RevertAutoEnrolledBlockResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/revert').then((m) => m.POST),
      },
      {
        // multipart 首例：handler 内 req.formData()（Web 标准），Hono 直通。
        method: 'POST',
        path: '/api/assets',
        load: () => import('./api/assets').then((m) => m.POST),
      },
      {
        method: 'DELETE',
        path: '/api/assets/[id]',
        load: () => import('./api/asset-delete').then((m) => m.DELETE),
      },
      {
        method: 'GET',
        path: '/api/assets/[id]/content',
        load: () => import('./api/asset-content').then((m) => m.GET),
      },
      // M5-T5a (YUK-321) — 手输错题通道收编（D11：错题是题目的标记不是通道，
      // 录入域持有写入口；the old after() pattern 已改写 fire-and-forget，见 api/mistakes.ts）。
      {
        method: 'POST',
        path: '/api/mistakes',
        load: () => import('./api/mistakes').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/mistakes',
        load: () => import('./api/mistakes').then((m) => m.GET),
      },
    ],
  },
  jobs: {
    handlers: [
      {
        name: 'ingestion_operation',
        queue: 'agent',
        load: () =>
          import('./jobs/ingestion_operation').then((m) => m.buildIngestionOperationHandler),
      },
    ],
  },
  // M4-T4 (YUK-319)：proposal kind 归属声明。block_merge 的 accept applier 真身
  // 在 ./server/proposal-appliers（YUK-202 path-B，等价平移自 dispatch 壳）；
  // image_candidate 的在 ./server/image-candidate-accept（YUK-227 S3 Slice C，
  // 整文件随包迁入）。壳层 actions.ts 的 accept case 只路由到本包。
  proposals: {
    kinds: [{ kind: 'block_merge' }, { kind: 'image_candidate' }],
  },
  // M1-T6：录入面（学习记录 mode 按 D11 不迁）。
  ui: { pages: uiPagesFor('ingestion') },
  // M5-T3 (YUK-321) — copilot 工具归属声明。D11 已裁 record 渐废（裁决 d）：
  // 两工具等价平移不删；record 域退役时随本声明一并摘除（查 spec §1 D11 行）。
  copilotTools: {
    tools: [
      {
        name: 'query_records',
        load: () => import('@/server/ai/tools/context-readers').then((m) => m.queryRecordsTool),
      },
      {
        name: 'get_record_context',
        load: () => import('@/server/ai/tools/context-readers').then((m) => m.getRecordContextTool),
      },
    ],
  },
});
