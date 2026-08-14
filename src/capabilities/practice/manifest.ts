import {
  API_ERROR_RESPONSES,
  ApiErrorResponseSchema,
  ApiIdParamsSchema,
  CursorQuerySchema,
} from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import {
  AppealResponseSchema,
  AttemptResponseSchema,
  CreateAppealBodySchema,
  CreateAttemptBodySchema,
  CreateReviewSessionBody,
  EndReviewSessionBodySchema,
  LegacyReviewSessionTransitionResponseSchema,
  ReviewSessionCreatedSchema,
  ReviewSessionSchema,
  ReviewSessionTransitionSchema,
  UpdateReviewSessionBody,
} from './api/contracts';
import {
  DraftForceEnableBodySchema,
  DraftModerationParamsSchema,
  DraftPromotionResponseSchema,
  DraftReviewDetailResponseSchema,
  DraftReviewListQuerySchema,
  DraftReviewListResponseSchema,
} from './api/draft-moderation-contracts';
import {
  CreateLegacyPaperReviewSessionBodySchema,
  CreatePaperAnswerDraftBodySchema,
  CreatePaperSubmissionBodySchema,
  LegacyPaperAnswerDraftBodySchema,
  LegacyPaperSubmissionBodySchema,
  PaperAnswerDraftCreatedSchema,
  PaperAnswerDraftParamsSchema,
  PaperAnswerDraftSchema,
  PaperDetailResponseSchema,
  PaperListResponseSchema,
  PaperParamsSchema,
  PaperSubmissionResponseSchema,
} from './api/paper-contracts';
import {
  CreatePlacementQuestionSelectionBodySchema,
  CreatePlacementSessionBodySchema,
  EndPlacementSessionBodySchema,
  LegacyPlacementSessionTransitionResponseSchema,
  PlacementProfileQuerySchema,
  PlacementProfileResponseSchema,
  PlacementQuestionSelectionResponseSchema,
  PlacementSessionCreatedSchema,
  PlacementSessionParamsSchema,
  PlacementSessionResponseSchema,
  PlacementSessionTransitionResponseSchema,
  UpdatePlacementSessionBodySchema,
} from './api/placement-contracts';
import {
  CreateHintRequestBodySchema,
  CreateSolveSessionBodySchema,
  CreateSolveSubmissionBodySchema,
  DeleteQuestionQuerySchema,
  DeleteQuestionResponseSchema,
  HintRequestBodySchema,
  HintRequestResponseSchema,
  QuestionDetailQuerySchema,
  QuestionDetailResponseSchema,
  QuestionListQuerySchema,
  QuestionListResponseSchema,
  QuestionParamsSchema,
  QuestionSolveParamsSchema,
  SolveSessionCreatedSchema,
  SolveSessionParamsSchema,
  SolveSessionResponseSchema,
  SolveSubmissionBodySchema,
  SolveSubmissionResponseSchema,
  StartSolveBodySchema,
  UpdateQuestionBodySchema,
  UpdateQuestionResponseSchema,
} from './api/question-solve-contracts';
import {
  FixedAnchorBodySchema,
  FixedAnchorResponseSchema,
  ReviewAdviceBodySchema,
  ReviewAdviceResponseSchema,
  ReviewDueQuerySchema,
  ReviewDueResponseSchema,
  ReviewWeeklyQuerySchema,
  ReviewWeeklyResponseSchema,
} from './api/review-planning-contracts';
import {
  PracticeStreamItemUpdatedResponseSchema,
  PracticeStreamQuerySchema,
  PracticeStreamRecomposedResponseSchema,
  PracticeStreamResponseSchema,
  RecomposePracticeStreamBodySchema,
  UpdatePracticeStreamItemBodySchema,
} from './api/stream-contracts';
// YUK-594 (durable judge main path, W1) — judge_run poll-tier status + 202-pending schemas
// (live in the db-free judge-run-status module so this eager import stays db-light).
import {
  JudgeDurablePendingResponseSchema,
  JudgeRunStatusResponseSchema,
} from './server/judge-run-status';

export const practiceCapability = defineCapability({
  name: 'practice',
  description:
    '练习消费侧：作答、判分、错因学习、针对性变式、FSRS 传感器、卷（paper）机制与会话编排。',
  // YUK-573 — judge 校准观测事件归属（report-only）：sample = 每条复判对照一行
  // （caused_by = 原 judge event，MF8 partial unique index 唯一化）；run_summary =
  // 每次 run 一行（mass-skip 自曝面）。写者只有 judge_calibration_sample job。
  events: {
    actions: [
      // Canonical learner response fact. Failure Learning subscribes to this
      // owner event instead of coupling every producer to a queue name.
      'attempt',
      // Canonical learner review publisher (api/submit.ts). Declaring its
      // ownership lets other capabilities consume reviews through the durable
      // event-subscription kernel instead of polling Practice internals.
      'review',
      // Canonical judge publisher (submit + rejudge); Agency consumes trusted
      // verdicts for intervention settlement.
      'judge',
      'experimental:judge_calibration_sample',
      'experimental:judge_calibration_run_summary',
      'experimental:hint_request',
      'experimental:mastery_progress',
      // YUK-777 A2 — durable judge 面「作答已录、判词未落」的不可变证据。写者只有 submit
      // 面的 enqueueDurableJudge；消费者是 judge_pending_reconcile sweeper 与 submit 的
      // late-arrival guard（server/judge-run-dispatch.ts）。
      'experimental:judge_pending_attempt',
    ],
  },
  subscriptions: {
    handlers: [
      {
        id: 'practice.failure-learning-attempt',
        version: 1,
        actions: ['attempt'],
        load: () =>
          import('./server/failure-learning-subscription').then(
            (m) => m.buildFailureLearningAttemptSubscriber,
          ),
      },
    ],
  },
  api: {
    // M2-T1 (YUK-316)：18 条路由全部带 load 懒加载 thunk（M1 配方）。[id]/[sid]
    // 段由 server/app.ts 的 toHonoPath 转 :id/:sid 并把捕获参数透传 handler。
    // 注：/api/practice/[id]/answer 实际是 POST（P2a 声明误写 PUT，壳与包从来是 POST）。
    routes: [
      {
        method: 'POST',
        path: '/api/review/submit',
        operationId: 'createReviewAttemptLegacy',
        request: { body: CreateAttemptBodySchema },
        // YUK-594 — flag-on async-main divert returns 202-pending (JudgeDurablePendingResponse);
        // registering 202 lets assertApiRouteSuccessStatus admit it (else the 202 is rejected).
        responses: {
          200: AttemptResponseSchema,
          202: JudgeDurablePendingResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 202],
        deprecation: { successor: '/api/attempts', since: '@1783987200' },
        load: () => import('./api/submit').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/attempts',
        operationId: 'createAttempt',
        request: { body: CreateAttemptBodySchema },
        // YUK-594 — createAttemptResource passes a 202-pending divert through (see submit.ts).
        responses: {
          201: AttemptResponseSchema,
          202: JudgeDurablePendingResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [201, 202],
        load: () => import('./api/submit').then((m) => m.createAttemptResource),
      },
      {
        method: 'GET',
        path: '/api/review/due',
        operationId: 'listDueReviews',
        request: { query: ReviewDueQuerySchema },
        responses: { 200: ReviewDueResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/due').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/advice',
        operationId: 'previewReviewAdvice',
        request: { body: ReviewAdviceBodySchema },
        responses: { 200: ReviewAdviceResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/advice').then((m) => m.POST),
      },
      {
        // YUK-594 (durable judge main path, W1) — poll-tier status snapshot for a
        // durable judge_run (D2 three-tier backfill: SSE + poll + replay). Read-only
        // job_events replay → deriveJudgeRunStatus + terminal verdict. The 202-pending
        // contract's poll_url points here (submit.ts enqueueDurableJudge).
        method: 'GET',
        path: '/api/jobs/judge_run/[id]/status',
        operationId: 'getJudgeRunStatus',
        request: { params: ApiIdParamsSchema },
        responses: { 200: JudgeRunStatusResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/judge-run-status-route').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/review/weekly',
        operationId: 'getWeeklyReviewReport',
        request: { query: ReviewWeeklyQuerySchema },
        responses: { 200: ReviewWeeklyResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/weekly').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/appeal',
        operationId: 'createReviewAppealLegacy',
        request: { body: CreateAppealBodySchema },
        responses: { 200: AppealResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/appeals', since: '@1783987200' },
        load: () => import('./api/appeal').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/appeals',
        operationId: 'createAppeal',
        request: { body: CreateAppealBodySchema },
        responses: { 201: AppealResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/appeal').then((m) => m.createAppealResource),
      },
      {
        method: 'POST',
        path: '/api/review/sessions',
        operationId: 'createReviewSessionLegacy',
        request: { body: CreateReviewSessionBody, bodyRequired: false },
        responses: { 200: ReviewSessionCreatedSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/review-sessions', since: '@1783987200' },
        load: () => import('./api/legacy-review-sessions').then((m) => m.POST),
      },
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
        load: () => import('./api/resource-routes').then((m) => m.createPaperAnswerDraftResource),
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
        load: () => import('./api/resource-routes').then((m) => m.createPaperSubmissionResource),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/pause',
        operationId: 'pauseReviewSessionLegacy',
        request: { params: ApiIdParamsSchema },
        responses: { 200: LegacyReviewSessionTransitionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/review-sessions/[id]', since: '@1783987200' },
        load: () => import('./api/session-pause').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/resume',
        operationId: 'resumeReviewSessionLegacy',
        request: { params: ApiIdParamsSchema },
        responses: { 200: LegacyReviewSessionTransitionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/review-sessions/[id]', since: '@1783987200' },
        load: () => import('./api/session-resume').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/end',
        operationId: 'endReviewSessionLegacy',
        request: {
          params: ApiIdParamsSchema,
          body: EndReviewSessionBodySchema,
          bodyRequired: false,
        },
        responses: { 200: LegacyReviewSessionTransitionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/review-sessions/[id]', since: '@1783987200' },
        load: () => import('./api/session-end').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/reopen',
        operationId: 'reopenReviewSessionLegacy',
        request: { params: ApiIdParamsSchema },
        responses: { 200: LegacyReviewSessionTransitionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/review-sessions/[id]', since: '@1783987200' },
        load: () => import('./api/session-reopen').then((m) => m.POST),
      },
      // YUK-468 cold-start inc-B — placement probe 会话 API (dark-ship, gated on
      // PLACEMENT_PROBE_ENABLED). start → first question; [id]/next → terminate-check + next
      // question; [id]/end → complete/abandon. Answers now go through /api/attempts with the
      // probe's session_id (shared judge + θ̂ path, no separate placement submit).
      {
        method: 'POST',
        path: '/api/placement/start',
        operationId: 'createPlacementSessionLegacy',
        request: { body: CreatePlacementSessionBodySchema },
        responses: { 200: PlacementSessionCreatedSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/placement-sessions', since: '@1783987200' },
        load: () => import('./api/placement-start').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/placement/[id]/next',
        operationId: 'createPlacementQuestionSelectionLegacy',
        request: {
          params: PlacementSessionParamsSchema,
          body: CreatePlacementQuestionSelectionBodySchema,
        },
        responses: { 200: PlacementQuestionSelectionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: {
          successor: '/api/placement-sessions/[id]/question-selections',
          since: '@1783987200',
        },
        load: () => import('./api/placement-next').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/placement/[id]/end',
        operationId: 'endPlacementSessionLegacy',
        request: {
          params: PlacementSessionParamsSchema,
          body: EndPlacementSessionBodySchema,
          bodyRequired: false,
        },
        responses: {
          200: LegacyPlacementSessionTransitionResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        deprecation: { successor: '/api/placement-sessions/[id]', since: '@1783987200' },
        load: () => import('./api/placement-end').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/placement-sessions',
        operationId: 'createPlacementSession',
        request: { body: CreatePlacementSessionBodySchema },
        responses: { 201: PlacementSessionCreatedSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/placement-start').then((m) => m.createPlacementSessionResource),
      },
      {
        method: 'POST',
        path: '/api/placement-sessions/[id]/question-selections',
        operationId: 'createPlacementQuestionSelection',
        request: {
          params: PlacementSessionParamsSchema,
          body: CreatePlacementQuestionSelectionBodySchema,
        },
        responses: { 200: PlacementQuestionSelectionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-next').then((m) => m.createPlacementQuestionSelection),
      },
      {
        method: 'GET',
        path: '/api/placement-sessions/[id]',
        operationId: 'getPlacementSession',
        request: { params: PlacementSessionParamsSchema },
        responses: { 200: PlacementSessionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-session-detail').then((m) => m.GET),
      },
      {
        method: 'PATCH',
        path: '/api/placement-sessions/[id]',
        operationId: 'updatePlacementSession',
        request: {
          params: PlacementSessionParamsSchema,
          body: UpdatePlacementSessionBodySchema,
        },
        responses: { 200: PlacementSessionTransitionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-session-detail').then((m) => m.PATCH),
      },
      // YUK-473 Slice 4 — placement-done 起始档案读：GET ?goal=<id> → per-KC mastery over
      // the goal scope (getMasteryProjection SoT; untested in-scope KCs → tested:false).
      // Read-only. Literal `/profile` segment — distinct from `/placement/[id]/*`.
      {
        method: 'GET',
        path: '/api/placement/profile',
        operationId: 'getPlacementProfile',
        request: { query: PlacementProfileQuerySchema },
        responses: { 200: PlacementProfileResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-profile').then((m) => m.GET),
      },
      // YUK-402 inc-4a — owner manual gate (draft 池审核面)后端。list draft pool +
      // enable (normal B5 verify→promote) + force-enable (override + reason 留痕)。
      // gate op = verifyAndPromote (src/server/quiz/verify-and-promote.ts)；/api/*
      // 自动套 internal-token。审核面属练习消费侧（draft 是 practice-pool 题）。
      {
        method: 'GET',
        path: '/api/review/drafts',
        operationId: 'listReviewDrafts',
        request: { query: DraftReviewListQuerySchema },
        responses: { 200: DraftReviewListResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 50, maxLimit: 200 },
        load: () => import('./api/review-drafts-list').then((m) => m.GET),
      },
      // YUK-403 inc-4b — full-text draft preview (loom preview pane data source).
      {
        method: 'GET',
        path: '/api/review/drafts/[id]',
        operationId: 'getReviewDraft',
        request: { params: DraftModerationParamsSchema },
        responses: { 200: DraftReviewDetailResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/review-draft-detail').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/drafts/[id]/enable',
        operationId: 'enableReviewDraft',
        request: { params: DraftModerationParamsSchema },
        responses: { 200: DraftPromotionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/review-draft-enable').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/drafts/[id]/force-enable',
        operationId: 'forceEnableReviewDraft',
        request: { params: DraftModerationParamsSchema, body: DraftForceEnableBodySchema },
        responses: { 200: DraftPromotionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/review-draft-force-enable').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/practice',
        operationId: 'listPapersLegacy',
        request: { query: CursorQuerySchema },
        responses: { 200: PaperListResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 50, maxLimit: 200 },
        deprecation: { successor: '/api/papers', since: '@1783987200' },
        load: () => import('./api/legacy-practice').then((m) => m.GET),
      },
      {
        // 开卷：start a review session bound to a paper artifact（M2-T6 补登：
        // handler 随 P2a 已迁入 papers-list.ts，manifest 此前漏了 POST 条目）。
        method: 'POST',
        path: '/api/practice',
        operationId: 'createPaperReviewSessionLegacy',
        request: { body: CreateLegacyPaperReviewSessionBodySchema },
        responses: { 200: ReviewSessionCreatedSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: { successor: '/api/review-sessions', since: '@1783987200' },
        load: () => import('./api/legacy-practice').then((m) => m.POST),
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
        // M2 流编排器（YUK-316）。静态段 'stream' 在 Hono 中优先于 :id 匹配。
        method: 'GET',
        path: '/api/practice/stream',
        operationId: 'getPracticeStream',
        request: { query: PracticeStreamQuerySchema },
        responses: { 200: PracticeStreamResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/stream').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/practice/stream/recompose',
        operationId: 'recomposePracticeStream',
        request: { body: RecomposePracticeStreamBodySchema, bodyRequired: false },
        responses: { 200: PracticeStreamRecomposedResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/stream').then((m) => m.POST),
      },
      {
        method: 'PATCH',
        path: '/api/practice/stream/items/[id]',
        operationId: 'updatePracticeStreamItem',
        request: { params: ApiIdParamsSchema, body: UpdatePracticeStreamItemBodySchema },
        responses: { 200: PracticeStreamItemUpdatedResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/stream').then((m) => m.PATCH),
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
      {
        method: 'POST',
        path: '/api/practice/[id]/submit',
        operationId: 'createPaperSubmissionLegacy',
        request: { params: PaperParamsSchema, body: LegacyPaperSubmissionBodySchema },
        responses: { 200: PaperSubmissionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: {
          successor: '/api/review-sessions/[id]/submissions',
          since: '@1783987200',
        },
        load: () => import('./api/paper-submit-route').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/practice/[id]/answer',
        operationId: 'createPaperAnswerDraftLegacy',
        request: { params: PaperParamsSchema, body: LegacyPaperAnswerDraftBodySchema },
        responses: { 200: PaperAnswerDraftCreatedSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: {
          successor: '/api/review-sessions/[id]/answer-drafts',
          since: '@1783987200',
        },
        load: () => import('./api/paper-answer-route').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve',
        operationId: 'startQuestionSolveLegacy',
        request: { params: QuestionParamsSchema, body: StartSolveBodySchema },
        responses: { 200: SolveSessionCreatedSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: {
          successor: '/api/solve-sessions',
          since: '@1783987200',
        },
        load: () => import('./api/solve-start').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve/[sid]/submit',
        operationId: 'submitQuestionSolveLegacy',
        request: { params: QuestionSolveParamsSchema, body: SolveSubmissionBodySchema },
        responses: { 200: SolveSubmissionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        deprecation: {
          successor: '/api/solve-sessions/[sid]/submissions',
          since: '@1783987200',
        },
        load: () => import('./api/solve-submit').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve/[sid]/hint',
        operationId: 'requestQuestionSolveHintLegacy',
        request: { params: QuestionSolveParamsSchema, body: HintRequestBodySchema },
        responses: {
          200: HintRequestResponseSchema,
          ...API_ERROR_RESPONSES,
          502: ApiErrorResponseSchema,
        },
        successStatus: 200,
        deprecation: {
          successor: '/api/solve-sessions/[sid]/hint-requests',
          since: '@1783987200',
        },
        load: () => import('./api/solve-hint').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/solve-sessions',
        operationId: 'createSolveSession',
        request: { body: CreateSolveSessionBodySchema },
        responses: { 201: SolveSessionCreatedSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/resource-routes').then((m) => m.createSolveSessionResource),
      },
      {
        method: 'GET',
        path: '/api/solve-sessions/[sid]',
        operationId: 'getSolveSession',
        request: { params: SolveSessionParamsSchema },
        responses: { 200: SolveSessionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/solve-session-detail').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/solve-sessions/[sid]/hint-requests',
        operationId: 'createSolveHintRequest',
        request: { params: SolveSessionParamsSchema, body: CreateHintRequestBodySchema },
        responses: {
          201: HintRequestResponseSchema,
          ...API_ERROR_RESPONSES,
          502: ApiErrorResponseSchema,
        },
        successStatus: 201,
        load: () => import('./api/resource-routes').then((m) => m.createHintRequestResource),
      },
      {
        method: 'POST',
        path: '/api/solve-sessions/[sid]/submissions',
        operationId: 'createSolveSubmission',
        request: { params: SolveSessionParamsSchema, body: CreateSolveSubmissionBodySchema },
        responses: { 201: SolveSubmissionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/resource-routes').then((m) => m.createSolveSubmissionResource),
      },
      // M5-T5a (YUK-321) — 题库 CRUD（D16 出 M2 范围，留旧栈至 M5 收口——
      // vite.config M2 注释——现收编）。
      {
        method: 'GET',
        path: '/api/questions',
        operationId: 'listQuestions',
        request: { query: QuestionListQuerySchema },
        responses: { 200: QuestionListResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: { kind: 'cursor', defaultLimit: 50, maxLimit: 200 },
        load: () => import('./api/questions-list').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/questions/[id]',
        operationId: 'getQuestion',
        request: { params: QuestionParamsSchema, query: QuestionDetailQuerySchema },
        responses: { 200: QuestionDetailResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/question-detail').then((m) => m.GET),
      },
      {
        method: 'PATCH',
        path: '/api/questions/[id]',
        operationId: 'updateQuestion',
        request: { params: QuestionParamsSchema, body: UpdateQuestionBodySchema },
        responses: { 200: UpdateQuestionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/question-detail').then((m) => m.PATCH),
      },
      {
        method: 'DELETE',
        path: '/api/questions/[id]',
        operationId: 'deleteQuestion',
        request: { params: QuestionParamsSchema, query: DeleteQuestionQuerySchema },
        responses: { 200: DeleteQuestionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/question-detail').then((m) => m.DELETE),
      },
      // YUK-453 (cold-start inc-A) — owner FIXED-ANCHOR write face. owner 钦定 ~5-10 道
      // 锚题的难度档（粗分桶）→ item_calibration source='fixed_anchor'。n=1 唯一不违红线
      // 的「校 LLM 难度系统性 offset」杠杆（cold-start day-one design §5 inc-A / §4.1）。
      // 写真身在 src/server/mastery/fixed-anchor.ts（item_calibration 单写者契约）；handler
      // 只 CALL setFixedAnchors。/api/* internal-token 由组合根中间件统一施加。
      {
        method: 'POST',
        path: '/api/practice/calibration/anchors',
        operationId: 'setPracticeCalibrationAnchors',
        request: { body: FixedAnchorBodySchema },
        responses: { 200: FixedAnchorResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/calibration-anchors').then((m) => m.POST),
      },
    ],
  },
  jobs: {
    // M4-T3 (YUK-319)：practice 域 job 归属声明。rejudge（M2/D15 申诉自动重判）
    // 注册留在 handlers.ts 渐缩簿：其注册形态是非默认 1s polling + inline 动态
    // import handleRejudge（非 buildXHandler 工厂），不走注册器统一配方——此处
    // 声明无 load 纯归属元数据。（YUK-349：review_plan 链式 job 已随 B3 退役。）
    handlers: [
      {
        // Durable stage 1: classify an active question failure, write the exact
        // causal judge, then hand off stage 2 with a stable per-attempt job id.
        name: 'attribution_followup',
        queue: 'llm',
        load: () =>
          import('./jobs/attribution_followup').then((m) => m.buildAttributionFollowupHandler),
      },
      {
        // Durable stage 2: propose-only cause-targeted variant generation.
        name: 'variant_gen',
        queue: 'llm',
        load: () => import('./jobs/variant_gen').then((m) => m.buildVariantGenHandler),
      },
      { name: 'rejudge', queue: 'llm' },
      // YUK-594 (durable judge main path, W1) — durable judge_run（异步为主路径）。
      // 注册留 handlers.ts 渐缩簿：形态要 includeMetadata:true 读 retryCount 驱动
      // 跨 provider lane 决策（D9），非注册器统一配方——此处无 load 纯归属元数据。
      { name: 'judge_run', queue: 'llm' },
      // YUK-777 A3 — durable judge 的 domain-state-scan reconcile sweeper。扫「作答已录、
      // 判词未落」的 pending attempt，经同一 rate-limited 入队面重投 judge_run。自身不做
      // LLM 调用（付费发生在 judge_run），故 fast 层。
      {
        name: 'judge_pending_reconcile',
        schedule: {
          cron: '50 * * * *',
          tz: 'Asia/Shanghai',
          singletonKey: 'judge_pending_reconcile-sweep',
          singletonSeconds: 60 * 60,
        },
        queue: 'fast',
        load: () =>
          import('./jobs/judge_pending_reconcile').then((m) => m.buildJudgePendingReconcileHandler),
      },
      // B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask 冷启先验 backfill。夜间扫
      // 无 item_calibration 硬轨 row 的题，逐题估 b 写锚（出题 + 录入两条路径产生
      // 的新题都被此 job 兜住，无需每条创建路径埋 hook）。
      {
        // YUK-758 DAG 成员（根）：item_calibration b 锚**种子**写者。recalibration 在其后 firm-up
        // 同表 b_calib → item_prior 是 recalibration 的硬上游（写序：种子先、firm 后）。cron 移除。
        name: 'item_prior_backfill',
        dependsOn: [],
        queue: 'llm',
        load: () =>
          import('./jobs/item_prior_backfill').then((m) => m.buildItemPriorBackfillHandler),
      },
      // YUK-361 Phase 4 (Task 9) — hybrid 运行时夜间预产 job。每夜（用户晨起前）为「今天」
      // 预产练习流，省去首读 lazy compose 的 LLM 网络往返。排在数据预产链之后跑，让选题
      // 信号（θ̂ / b 锚）已新鲜——YUK-758 起该次序由下面的 dependsOn 硬边保证，不再靠 cron
      // 错峰。（旧注「mastery 夜链」已删——该 job 从不存在，mastery_state 在线写入；YUK-377
      // 复审 §6.4。）queue=llm：softmax_mfi 默认路径会调 SelectionOrchestratorTask（LLM
      // 编排），与 item_prior 同档。
      // 幂等由 composeNightly 的单飞锁 + 双重检查保证（夜产后用户首读 lazy 命中 no-op）。
      {
        // YUK-758 DAG 成员：compose 选题（candidate-signals）实读 item_calibration.b_calib，故对
        // recalibration_nightly 是**真硬边**（读最终标定态）。注：reference_md / answer_class **不**入
        // compose 选题路径（reference_md 走判分/UI、answer_class 走 quiz/pool-fetch），旧 05:00/05:20
        // 排在 compose 前是时钟巧合，不作伪边纳入（见 PR 考据表）。cron 移除，orchestrator 触发。
        name: 'practice_stream_compose_nightly',
        dependsOn: ['recalibration_nightly'],
        queue: 'llm',
        load: () =>
          import('./jobs/practice_stream_compose_nightly').then(
            (m) => m.buildStreamComposeNightlyHandler,
          ),
      },
      // YUK-372 L5 (YUK-361 Phase 8 wire-up) — 供给目标发现 + 派发夜扫。确定性缺口扫描
      // （discoverSupplyTargets，零写零 LLM）→ dispatchSupplyTargets 派到既有 sourcing /
      // quiz_gen 队列或标 manual。排在数据预产链之后跑，让前沿/题池信号已新鲜、缺口判定准
      // ——YUK-758 起该次序由下面的 dependsOn 硬边保证，不再靠 cron 错峰。（旧注「mastery
      // 夜链」已删——该 job 从不存在。）
      // queue=llm：派出的 sourcing / quiz_gen 本身是 LLM 重型 job，本 job 与其同档 DLQ 重试。
      // **成本护栏**：dispatcher 的 7d fingerprint cooldown 是唯一防 job-spam 闸（同未满足缺口
      // 7 天内只真派一次）；本 job 依赖它，绝不绕过 dispatcher 直发付费队列。
      {
        // YUK-758 DAG 成员。**边考据修订（review To-Iq + ToTas，两位 reviewer 各对一半）**：
        //  · 原声明的 `answer_class_backfill` 硬边**不成立，已移除**：supply 的
        //    discoverSupplyTargets → assembleScanInput → loadQuestionPool 是
        //    target-discovery.ts 内的**私有** loader（:664），并非 src/server/quiz/pool-fetch.ts；
        //    它只 select id/kind/source/metadata/difficulty/knowledge_ids(+draft_status 谓词)，
        //    全 src/server/question-supply/ 目录 grep 不到 answer_class。且 pool-fetch 那条
        //    answer_class 谓词本身是 NULL-宽容（`= X OR IS NULL`）且当前无活 caller（唯一
        //    would-be caller matcher 被 MATCHER_ANSWER_CLASS_FILTER=false 关着）——即便走到
        //    也不会因未 backfill 而漏题。故原「answer_class 新鲜 → 缺口判定准」是伪依赖。
        //  · 改声明 `recalibration_nightly` 硬边（**真读后写**）：同一个私有 loadQuestionPool
        //    在 target-discovery.ts:684-699 批量读 item_calibration(track='hard') 的
        //    b/b_anchor/b_calib → effectiveB(= b_calib ?? b_anchor ?? b)，该值喂 R3 的
        //    「无近-θ̂ 锚」判定（:490-511）并直接决定是否派**付费** diagnostic 供给目标。
        //    这与 compose 对 recalibration 的既有硬边是**同一列同一 resolver**。上游未 firm-up
        //    就扫 → 拿陈旧 b 误判 mis-banded → 派本不需要的付费 job。经 item_prior_backfill
        //    传递依赖（recalibration ← item_prior），整条标定链齐了才扫。cron 移除。
        name: 'question_supply_nightly',
        dependsOn: ['recalibration_nightly'],
        queue: 'llm',
        load: () =>
          import('./jobs/question_supply_nightly').then((m) => m.buildQuestionSupplyNightlyHandler),
      },
      // YUK-533 (ADR-0036 RT1 consumer) — confusable-contrast supply discovery + dispatch.
      // Scans the confusable_with misconception mesh → one supply target per confusable KC
      // pair → quiz_gen propose-only drafts. DARK behind CONFUSABLE_CONTRAST_ENABLED (discovery
      // NO-OPs flag-off). cron 06:20 Asia/Shanghai: the last supply lane, right after
      // question_supply_nightly (06:00), in a clear slot. queue=llm: the dispatched quiz_gen
      // jobs are LLM-heavy, same DLQ/retry bucket. **成本护栏**：依赖 dispatcher 的 7d
      // fingerprint cooldown + 本 job 的 per-run cap，绝不绕 dispatcher 直发付费队列。
      {
        name: 'confusable_contrast_nightly',
        schedule: { cron: '20 6 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/confusable_contrast_nightly').then(
            (m) => m.buildConfusableContrastNightlyHandler,
          ),
      },
      // YUK-372 L1 (YUK-361 Phase 6 wire-up, ADR-0043 §4) — active-PPI 难度重标定触发器。
      // recalibrateQuestion（建好但 Phase 6 无生产 caller 的离线 b 去偏引擎）的夜间触发：每夜扫
      // 「攒够标签 + 昨日起窗内有新标签」的非 draft 题，逐题 firm-up b_calib（track='hard'）。
      // 排在 item_prior 之后、compose/supply 之前——这样今晨 firm 的 b_calib 被当天的选题与
      // 缺口扫描读到；YUK-758 起该次序由 dependsOn 硬边保证，不再靠 cron 错峰。queue=llm：
      // 与其它慢热 job 同档 DLQ 重试（慢资产写慢，给重试余量）。recalibrateQuestion 在 job
      // 顶层调（非 attempt tx 内），per-question try/catch 隔离单题失败，不加 SAVEPOINT（G1）。
      {
        // YUK-758 DAG 成员：firm-up item_calibration.b_calib（track='hard'）。对 item_prior_backfill
        // 是硬边（同表 b 锚：种子先、firm 后），且是 compose 选题实读的最终标定态上游。cron 移除。
        name: 'recalibration_nightly',
        dependsOn: ['item_prior_backfill'],
        queue: 'llm',
        load: () =>
          import('./jobs/recalibration_nightly').then((m) => m.buildRecalibrationNightlyHandler),
      },
      // YUK-383 Phase 0 — 语义 embedding 地基 backfill。每夜嵌入 embedding IS NULL
      // 的 question + knowledge 行（存量 backfill + 次日新行 + embed-API 故障重试，
      // §9 fallback）。
      // queue=llm：与其它慢热 backfill job 同档 DLQ 重试。幂等由 embedding IS NULL
      // 过滤保证（无 NULL 行 = no-op）；embedMany throw 留 NULL 下轮重试，不阻塞入库。
      {
        // YUK-758 DAG 成员（根）：嵌入 question/knowledge 的 embedding 列。kc_dedup_nightly 硬门
        // embedding IS NOT NULL → embed_backfill 是 kc_dedup 的**真硬边**上游（跨包：kc_dedup 在
        // knowledge 包）。cron 移除，orchestrator 起步即触发。
        name: 'embed_backfill',
        dependsOn: [],
        queue: 'llm',
        load: () => import('./jobs/embed_backfill').then((m) => m.buildEmbedBackfillHandler),
      },
      // YUK-489 (P4a) — reference-answer backfill. P3 decoupled cold-start-bridge ③
      // (reference generation) from KC tagging: a prompt-only OCR question persists
      // with reference_md IS NULL (auto-enroll / image-candidate-accept). This job
      // fills those nulls nightly + independently, REUSING generateReferenceSolution
      // (no new task). Trigger = reference_md IS NULL AND ≥1 knowledge_id (resolvable
      // subject); no-knowledge_id rows are skipped. cron 05:20 Asia/Shanghai: in a
      // clear slot after the data-prep chain (item_prior 04:20 / recalibration 04:50 /
      // answer_class 05:00 / kt_estimate 05:10) and BEFORE compose 05:30 — so a freshly
      // filled reference_md is available to the day's stream selection + judge. queue=llm:
      // generateReferenceSolution runs SolutionGenerateTask (LLM) — same DLQ/retry bucket
      // as the other slow backfills. Idempotent via the reference_md IS NULL filter
      // (no NULL rows = no-op); a per-row solver skipped_error leaves the row NULL for
      // the next run, the batch continues (embed_backfill per-row contract).
      {
        name: 'reference_answer_backfill',
        schedule: { cron: '20 5 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/reference_answer_backfill').then(
            (m) => m.buildReferenceAnswerBackfillHandler,
          ),
      },
      // YUK-390 kind Step 3 — answer_class materialization backfill. Classifies
      // answer_class IS NULL question rows via deriveAnswerClass (pure, no API),
      // for retrieval filtering + the kind reshape. No dependency on other jobs
      // (pure derivation).
      // queue=llm: shares the established backfill DLQ/retry bucket. Idempotent via
      // the answer_class IS NULL filter (no NULL rows = no-op).
      {
        // YUK-758 DAG 成员（根）：物化 answer_class（纯派生，无夜链上游）。**无下游硬边**——
        // question_supply 曾被声明为其下游，但考据（review To-Iq/ToTas）证伪：supply 的读路径
        // 不碰 answer_class（详见 question_supply_nightly 处的边考据）。本 job 保持图成员是
        // 为了受锚点统一触发，不是因为有人等它。cron 移除。
        name: 'answer_class_backfill',
        dependsOn: [],
        queue: 'llm',
        load: () =>
          import('./jobs/answer_class_backfill').then((m) => m.buildAnswerClassBackfillHandler),
      },
      // YUK-348 (B1 four-engine soft-track inc-1, ADR-0035 决定 #3 + 决定 #4 红线) — 软轨 KT
      // 估计夜扫。每夜扫「有硬轨 item_calibration 行 + 有非空二元作答序列」的非 draft 题，逐题
      // estimateBkt (纯 BKT forward) → applyKtEstimate 落 item_calibration.kt_json。kt_json 是
      // **纯持久化 sink，零下游消费者**——不喂 p(L)/调度/显示（PFA 是唯一可信决策信号，决定 #4）；
      // n=1 下输出多为 prior-echo（预期且正确，价值在管线就位 + 扩多用户期权 + 诊断丰富度，决定 #3）。
      // cron 10 5 * * * Asia/Shanghai：错在 recalibration 04:50 + answer_class 05:00 之后、compose
      // 05:30 之前——晚于硬轨数据预产（item_prior 04:20 / recalibration 04:50），让 KT 读到的作答
      // 序列已新鲜，且不与前两 job 同分钟竞争。queue=llm：与其它慢热 backfill job 同档 DLQ 重试
      // （KT 估计本身纯 CPU，但与软/慢轨家族同档调度）。runKtEstimateNightly 在 job 顶层调（非
      // attempt tx 内），per-question try/catch 隔离单题失败，不加 SAVEPOINT（G1）。
      {
        name: 'kt_estimate_nightly',
        schedule: { cron: '10 5 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/kt_estimate_nightly').then((m) => m.buildKtEstimateNightlyHandler),
      },
      // YUK-445 (A11 — 谨慎 / 速度-精度轴) — EZ-diffusion 描述符夜扫。runAxisStateBatch 折叠
      // 计分 RT 作答 per 主 KC → 过 usage gate 的 KC upsert (drift_v/boundary_a/ter) 慢变描述符。
      // 纯描述符，零下游消费者（不喂 p(L)/调度/θ̂；读出只走 placement-profile 显示）——故不触
      // LIVE 引擎、无 flag。provenance='adaptive'（唯一 live 源）→ 写 boundary_a+ter，drift_v
      // 留 NULL（自适应选题混淆，A11 硬边界）。cron 40 5 * * * Asia/Shanghai：错在数据预产链
      // （kt_estimate 05:10 / reference 05:20 / compose 05:30）之后的空槽——A11 只读 durable
      // attempt event，对选题链无序依赖，晚槽只为避同分钟竞争。queue=llm：与其它慢热 batch 同档
      // DLQ 重试（本 batch 纯 CPU+DB，无 LLM 调用）。per-KC upsert 独立 try/catch（不加 SAVEPOINT，
      // 非 attempt tx 内，G1 同 recalibration_nightly）。
      {
        name: 'axis_state_nightly',
        schedule: { cron: '40 5 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () => import('./jobs/axis_state_nightly').then((m) => m.buildAxisStateNightlyHandler),
      },
      // YUK-573 — judge 校准不同意率采样（report-only，dark-ship）。kill switch
      // JUDGE_CALIBRATION_SAMPLING_ENABLED 默认 OFF（cron 保持注册，handler no-op，
      // 零 spend）。复判走第二 lane（per-call ctx.override=anthropic-sub，绝不翻
      // 全局 AI_PROVIDER_OVERRIDE）。cron 06:10 Asia/Shanghai：排在既有夜链
      // （axis_state 05:40 / question_supply 06:00）之后的空槽，夜间避开 owner
      // 交互期减 Max 订阅 rate-limit 争用（S2）。queue:'agent'（EXPIRE_AGENT=
      // 7200s）：批内 ≤BATCH_MAX（默认 20）次 LLM 复判调用，是多次调用批任务，
      // 非单-shot 'llm' 档。幂等由 MF8 partial unique index（drizzle/0059）DB 层
      // 强制，expire 窗重投递安全。
      {
        name: 'judge_calibration_sample',
        schedule: { cron: '10 6 * * *', tz: 'Asia/Shanghai' },
        queue: 'agent',
        load: () =>
          import('./jobs/judge_calibration_sample').then(
            (m) => m.buildJudgeCalibrationSampleHandler,
          ),
      },
    ],
  },
  // M4-T4 (YUK-319)：proposal kind 归属声明。variant_question / question_draft
  // 的 accept applier 真身在 ./server/proposal-appliers；judge_retraction 有
  // producer（@/server/proposals/producers）但无 accept applier——accept 走
  // dispatch 壳 default throw（unsupported_proposal_kind，YUK-44 收口），归属
  // 声明与 applier 存在性解耦。
  // ADR-0032 D6-B (YUK-203 lane L6) — question_edit accept applier
  // （acceptQuestionEditProposal）也落在 ./server/proposal-appliers：active 题
  // structured 节点编辑属练习域（题库生命周期）。
  proposals: {
    kinds: [
      {
        kind: 'variant_question',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.variantQuestionProposalAcceptApplier,
            ),
        },
        dismiss: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.variantQuestionProposalDismissApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.variantQuestionProposalRetractApplier,
            ),
        },
      },
      {
        kind: 'question_draft',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.questionDraftProposalAcceptApplier,
            ),
        },
      },
      { kind: 'judge_retraction' },
      {
        kind: 'question_edit',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.questionEditProposalAcceptApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.questionEditProposalRetractApplier,
            ),
        },
      },
    ],
  },
  ui: { pages: uiPagesFor('practice') },
  // M5-T3 / YUK-328 — 完整 DomainTool 归属声明（字段名沿用 copilotTools）。
  // attribute_mistake / propose_variant 仅由 user-suggested mistake-action surface 授权；
  // ADR-0032 D6-B 的 propose_question_edit 则属于 Copilot base surface。
  copilotTools: {
    tools: [
      {
        name: 'get_question_context',
        load: () =>
          import('@/server/ai/tools/context-readers').then((m) => m.getQuestionContextTool),
      },
      {
        name: 'get_review_due',
        load: () => import('@/server/ai/tools/context-readers').then((m) => m.getReviewDueTool),
      },
      {
        name: 'get_attempt_context',
        load: () =>
          import('@/server/ai/tools/get-attempt-context').then((m) => m.getAttemptContextTool),
      },
      {
        name: 'query_mistakes',
        load: () => import('@/server/ai/tools/query-mistakes').then((m) => m.queryMistakesTool),
      },
      {
        name: 'attribute_mistake',
        load: () => import('./tools/attribute-mistake').then((m) => m.attributeMistakeTool),
      },
      {
        name: 'propose_variant',
        load: () => import('./tools/propose-variant').then((m) => m.proposeVariantTool),
      },
      {
        name: 'author_question',
        load: () => import('@/server/ai/tools/proposal-tools').then((m) => m.authorQuestionTool),
      },
      {
        name: 'query_questions',
        load: () => import('@/server/ai/tools/query-questions').then((m) => m.queryQuestionsTool),
      },
      {
        name: 'write_quiz',
        load: () => import('@/server/ai/tools/write-quiz').then((m) => m.writeQuizTool),
      },
      // ADR-0032 D6-B (YUK-203 lane L6) — active 题 structured 节点编辑 propose
      // 工具（窄 typed op；accept 经 practice applier + mini verify gate 落地）。
      {
        name: 'propose_question_edit',
        load: () =>
          import('@/server/ai/tools/proposal-tools').then((m) => m.proposeQuestionEditTool),
      },
    ],
  },
});
