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
  AssetContentResponseSchema,
  AssetDeleteResponseSchema,
  AssetUploadResponseSchema,
  CreateIngestionSessionBody,
  CreateMistakeBodySchema,
  CreateMistakeResponseSchema,
  CreationInternalErrorSchema,
  CreationReceiptConflictSchema,
  CreationReceiptHeadersSchema,
  CreationReceiptUnavailableSchema,
  DocxIngestionResponseSchema,
  IngestionAskAnswerBodySchema,
  IngestionAskAnswerHeadersSchema,
  IngestionAskAnswerResponseSchema,
  IngestionAskParamsSchema,
  IngestionBlocksResponseSchema,
  IngestionCreationErrorSchema,
  IngestionEventStreamResponseSchema,
  IngestionEventsHeadersSchema,
  IngestionOperationSchema,
  IngestionSessionCreationResponseSchema,
  IngestionSessionDetailResponseSchema,
  IngestionSessionHistoryResponseSchema,
  IngestionSessionSchema,
  LegacyMakePaperResponseSchema,
  LegacyRescueResponseSchema,
  MistakeListQuerySchema,
  MistakeListResponseSchema,
  MultipartDocxUploadSchema,
  MultipartFileUploadSchema,
  PdfExpansionResponseSchema,
  RevertAutoEnrolledBlockBodySchema,
  RevertAutoEnrolledBlockResponseSchema,
} from './api/contracts';
import { IngestionOperationRequest, MakePaperBody, RescueBody } from './api/operation-schema';

export const ingestionCapability = defineCapability({
  name: 'ingestion',
  description:
    '录入：任何题目进系统的通道（拍照/PDF/DOCX/手输 → 原图留存 → OCR/VLM 三层提取 → 切块 → 标注 → 入库）。错题是题目的标记不是通道（D11）。',
  api: {
    // Every route lazy-loads through `load` so the manifest stays pure metadata.
    // [id] segments are converted to :id by the app and passed to the handler.
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
        request: { body: CreateIngestionSessionBody, headers: CreationReceiptHeadersSchema },
        responses: {
          200: IngestionSessionCreationResponseSchema,
          ...API_ERROR_RESPONSES,
          409: CreationReceiptConflictSchema,
          500: IngestionCreationErrorSchema,
          503: CreationReceiptUnavailableSchema,
        },
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
        request: { body: CreateIngestionSessionBody, headers: CreationReceiptHeadersSchema },
        responses: {
          201: IngestionSessionCreationResponseSchema,
          ...API_ERROR_RESPONSES,
          409: CreationReceiptConflictSchema,
          500: IngestionCreationErrorSchema,
          503: CreationReceiptUnavailableSchema,
        },
        successStatus: 201,
        load: () => import('./api/sessions').then((m) => m.createIngestionSessionResource),
      },
      {
        method: 'GET',
        path: '/api/ingestion-sessions/[id]',
        operationId: 'getIngestionSession',
        request: { params: ApiIdParamsSchema },
        responses: { 200: IngestionSessionDetailResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/session-detail').then((m) => m.GET),
      },
      {
        // Durable read-back for reopening a finished session (YUK-1522 history).
        // Agent runs merge the agent_budget.history snapshot with whatever
        // job_events still survive the 30-day window; extract runs read blocks.
        method: 'GET',
        path: '/api/ingestion-sessions/[id]/history',
        operationId: 'getIngestionSessionHistory',
        request: { params: ApiIdParamsSchema },
        responses: {
          200: IngestionSessionHistoryResponseSchema,
          ...API_ERROR_RESPONSES,
          503: ApiErrorResponseSchema,
        },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/session-history').then((m) => m.GET),
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
          body: MultipartDocxUploadSchema,
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
        // Consumed with fetch + ReadableStream (never EventSource), so the normal
        // x-internal-token gate applies without an exemption.
        method: 'GET',
        path: '/api/ingestion/[id]/events',
        operationId: 'streamIngestionSessionEvents',
        request: { params: ApiIdParamsSchema, headers: IngestionEventsHeadersSchema },
        // Replay starts inside ReadableStream.start(); only auth can fail before the stream.
        responses: {
          200: IngestionEventStreamResponseSchema,
          401: ApiErrorResponseSchema,
        },
        responseMediaTypes: { 200: 'text/event-stream' },
        successStatus: 200,
        load: () => import('./api/events').then((m) => m.GET),
      },
      {
        // Durable ask answers. Idempotency-Key is required; 202 accept/replay, 409
        // resolved/conflict, 422 contract answer codes.
        method: 'POST',
        path: '/api/ingestion-sessions/[id]/asks/[ask_id]/answers',
        operationId: 'answerIngestionAsk',
        request: {
          params: IngestionAskParamsSchema,
          headers: IngestionAskAnswerHeadersSchema,
          body: IngestionAskAnswerBodySchema,
        },
        responses: {
          202: IngestionAskAnswerResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 202,
        load: () => import('./api/ask-answers').then((m) => m.POST),
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
          // 503 means the budget gate itself is unavailable; 429 is already covered.
          503: ApiErrorResponseSchema,
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
        // Handled with the standard req.formData() in Hono.
        method: 'POST',
        path: '/api/assets',
        operationId: 'createAsset',
        request: {
          body: MultipartFileUploadSchema,
          bodyMediaType: 'multipart/form-data',
        },
        responses: { 201: AssetUploadResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/assets').then((m) => m.POST),
      },
      {
        method: 'DELETE',
        path: '/api/assets/[id]',
        operationId: 'deleteAsset',
        request: { params: ApiIdParamsSchema },
        responses: { 200: AssetDeleteResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/asset-delete').then((m) => m.DELETE),
      },
      {
        method: 'GET',
        path: '/api/assets/[id]/content',
        operationId: 'getAssetContent',
        request: { params: ApiIdParamsSchema },
        responses: { 200: AssetContentResponseSchema, ...API_ERROR_RESPONSES },
        // Also serves frozen JS assets as inert text/plain with a CSP sandbox; both
        // representations are declared so generated clients model them.
        responseMediaTypes: { 200: ['image/*', 'text/plain', 'application/octet-stream'] },
        successStatus: 200,
        load: () => import('./api/asset-content').then((m) => m.GET),
      },
      // Mistakes are a question marker, not a separate channel (D11), so ingestion
      // owns the write path.
      {
        method: 'POST',
        path: '/api/mistakes',
        operationId: 'createMistake',
        request: { body: CreateMistakeBodySchema, headers: CreationReceiptHeadersSchema },
        responses: {
          201: CreateMistakeResponseSchema,
          ...API_ERROR_RESPONSES,
          409: CreationReceiptConflictSchema,
          500: CreationInternalErrorSchema,
          503: CreationReceiptUnavailableSchema,
        },
        successStatus: 201,
        load: () => import('./api/mistakes').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/mistakes',
        operationId: 'listMistakes',
        request: { query: MistakeListQuerySchema },
        responses: { 200: MistakeListResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 50, maxLimit: 200 },
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
      // AGENT tier with 2h expiry + DLQ; metadata carries retryCount for provider
      // resume. R2 is resolved lazily so the manifest stays metadata-only.
      {
        name: 'tencent_ocr_extract',
        queue: 'agent',
        pollingIntervalSeconds: 0.5,
        batchSize: 1,
        includeMetadata: true,
        load: async () => {
          const [{ buildTencentOcrHandler }, { getR2 }] = await Promise.all([
            import('./jobs/tencent_ocr_extract'),
            import('@/server/r2'),
          ]);
          return (db: Parameters<typeof buildTencentOcrHandler>[0]['db']) =>
            buildTencentOcrHandler({
              db,
              // Resolve R2 on first use; missing credentials fail at the handler.
              get r2() {
                return getR2();
              },
            } as Parameters<typeof buildTencentOcrHandler>[0]);
        },
      },
      // LLM tier with 1h expiry + DLQ.
      {
        name: 'auto_enroll',
        queue: 'llm',
        load: () => import('./jobs/auto_enroll').then((m) => m.buildAutoEnrollHandler),
      },
      // AGENT tier; one durable run per session spans deliveries, and ask
      // suspension exits the job until an answer or timeout re-dispatches.
      {
        name: 'ingestion_agent_run',
        queue: 'agent',
        // retryCount drives the exhausted terminal write; the heartbeat lets the
        // sweeper recover a crashed worker sooner on this 2h queue.
        includeMetadata: true,
        heartbeatSeconds: 300,
        load: () =>
          import('./jobs/ingestion_agent_run').then((m) => m.buildIngestionAgentRunHandler),
      },
      // Resolves expired asks as skipped-by-timeout and re-dispatches resume
      // markers that no running segment followed.
      {
        name: 'ingestion_ask_sweep',
        queue: 'fast',
        schedule: { cron: '* * * * *', tz: 'Asia/Shanghai' },
        load: () =>
          import('./jobs/ingestion_ask_sweep').then((m) => m.buildIngestionAskSweepHandler),
      },
    ],
  },
  // Proposal ownership; the shared dispatch only routes accepts here.
  proposals: {
    kinds: [
      {
        kind: 'block_merge',
        accept: {
          // Merging is irreversible, so accept requires explicit confirm_lossy.
          confirmLossy: true,
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.blockMergeProposalAcceptApplier,
            ),
        },
      },
      {
        kind: 'image_candidate',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.imageCandidateProposalAcceptApplier,
            ),
        },
      },
      {
        kind: 'record_links',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.recordLinksProposalAcceptApplier,
            ),
        },
      },
      {
        kind: 'record_promotion',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.recordPromotionProposalAcceptApplier,
            ),
        },
      },
    ],
  },
  ui: { pages: uiPagesFor('ingestion') },
  // Tool ownership. Draft block reader/edit tools are granted only on the
  // ingestion_block_edit surface, never to Copilot.
  copilotTools: {
    tools: [
      {
        name: 'query_records',
        load: () =>
          import('./server/tools/query-records').then((module) => module.queryRecordsTool),
      },
      {
        name: 'get_record_context',
        load: () =>
          import('./server/tools/get-record-context').then((module) => module.getRecordContextTool),
      },
      {
        name: 'get_question_block_structure',
        load: () =>
          import('./server/tools/question-block-structure').then(
            (module) => module.getQuestionBlockStructureTool,
          ),
      },
      {
        name: 'propose_record_links',
        load: () => import('./server/tools/proposal-tools').then((m) => m.proposeRecordLinksTool),
      },
      {
        name: 'propose_record_promotion',
        load: () =>
          import('./server/tools/proposal-tools').then((m) => m.proposeRecordPromotionTool),
      },
      // Registered but not granted on any surface: edits go through edit_question
      // and submission through submit_question. Kept for existing DB tests.
      {
        name: 'update_prompt',
        load: () =>
          import('./server/tools/question-block-node-edits').then(
            (module) => module.updatePromptTool,
          ),
      },
      {
        name: 'add_option',
        load: () =>
          import('./server/tools/question-block-node-edits').then((module) => module.addOptionTool),
      },
      {
        name: 'set_question_type',
        load: () =>
          import('./server/tools/question-block-node-edits').then(
            (module) => module.setQuestionTypeTool,
          ),
      },
      {
        name: 'split_stem',
        load: () =>
          import('./server/tools/question-block-node-edits').then((module) => module.splitStemTool),
      },
      {
        name: 'merge_questions',
        load: () =>
          import('./server/tools/question-block-structural-edits').then(
            (module) => module.mergeQuestionsTool,
          ),
      },
      {
        name: 'reassign_figure',
        load: () =>
          import('./server/tools/question-block-structural-edits').then(
            (module) => module.reassignFigureTool,
          ),
      },
      // Presentation composition uses the same binding validation as publishing;
      // it writes only structured.presentation and is granted only to ingestion.
      {
        name: 'compose_presentation',
        load: () =>
          import('./server/tools/compose-presentation').then(
            (module) => module.composePresentationTool,
          ),
      },
      // Source-package tools, granted only on the ingestion surface.
      {
        name: 'read_source',
        load: () => import('./server/tools/source-tools').then((module) => module.readSourceTool),
      },
      {
        name: 'view_image',
        load: () => import('./server/tools/media-tools').then((module) => module.viewImageTool),
      },
      {
        name: 'crop_image',
        load: () => import('./server/tools/media-tools').then((module) => module.cropImageTool),
      },
      {
        name: 'rotate_image',
        load: () => import('./server/tools/media-tools').then((module) => module.rotateImageTool),
      },
      {
        name: 'glm_ocr',
        load: () => import('./server/tools/media-tools').then((module) => module.glmOcrTool),
      },
      // Agent contract tools: progress feeds the durable SSE stream, and asks are
      // durable/resumable rather than a blocked worker.
      {
        name: 'report_ingestion_progress',
        load: () =>
          import('./server/tools/agent-tools').then((module) => module.reportIngestionProgressTool),
      },
      {
        name: 'ask_learner',
        load: () => import('./server/tools/agent-tools').then((module) => module.askLearnerTool),
      },
    ],
  },
});
