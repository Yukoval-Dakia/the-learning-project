// 学习安排 owner 的 manifest 片段，由根 `manifest.ts` 组合。
import { API_ERROR_RESPONSES, ApiIdParamsSchema } from '@/kernel/http-contracts';
import type { CapabilityManifest } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';
import { LEARNING_ACTIVITY_ACTIONS } from '@/kernel/read-models/learner-activity';
import { JudgeDurablePendingResponseSchema } from '../grading/public';
import {
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

export const schedulingManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
  subscriptions: {
    handlers: [
      {
        id: 'practice.learner-return-wake',
        version: 1,
        actions: [...LEARNING_ACTIVITY_ACTIONS],
        load: () =>
          import('./server/learner-return-wake').then((m) => m.buildLearnerReturnWakeSubscriber),
      },
    ],
  },
  api: {
    routes: [
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
        responses: {
          200: ReviewAdviceResponseSchema,
          202: JudgeDurablePendingResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 202],
        load: () => import('./api/advice').then((m) => m.POST),
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
        // M2 流编排器（YUK-316）。
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
    ],
  },
  jobs: {
    handlers: [
      // YUK-361 Phase 4 (Task 9) — hybrid 运行时夜间预产 job。每夜（用户晨起前）为「今天」
      // 预产练习流，省去首读 lazy compose 的 LLM 网络往返。排在数据预产链之后跑，让选题
      // 信号（θ̂ / b 锚）已新鲜——YUK-758 起该次序由下面的 dependsOn 硬边保证，不再靠 cron
      // 错峰。（旧注「mastery 夜链」已删——该 job 从不存在，mastery_state 在线写入；YUK-377
      // 复审 §6.4。）queue=llm：softmax_mfi 默认路径会调 SelectionOrchestratorTask（LLM
      // 编排），与 item_prior 同档。
      // 幂等由 composeNightly 的单飞锁 + 双重检查保证（夜产后用户首读 lazy 命中 no-op）。
      {
        // YUK-758 DAG 成员：compose 选题（candidate-signals）实读 item_calibration.b_post，故对
        // recalibration_nightly 是**真硬边**（读最终标定态）。注：reference_md / answer_class **不**入
        // compose 选题路径（reference_md 走判分/UI、answer_class 走 quiz/pool-fetch），旧 05:00/05:20
        // 排在 compose 前是时钟巧合，不作伪边纳入（见 PR 考据表）。cron 移除，orchestrator 触发。
        name: 'practice_stream_compose_nightly',
        dependsOn: ['recalibration_nightly'],
        eligibility: nightlyEligibility('deterministic', { usesModel: true }),
        queue: 'llm',
        load: () =>
          import('./jobs/practice_stream_compose_nightly').then(
            (m) => m.buildStreamComposeNightlyHandler,
          ),
      },
      {
        name: 'learner_return_wake',
        queue: 'llm',
        load: () =>
          import('./server/learner-return-wake').then((m) => m.buildLearnerReturnWakeHandler),
      },
    ],
  },
  copilotTools: {
    tools: [
      {
        name: 'get_question_context',
        load: () => import('./tools/question-context').then((m) => m.getQuestionContextTool),
      },
      {
        name: 'get_review_due',
        load: () => import('./tools/question-context').then((m) => m.getReviewDueTool),
      },
      {
        name: 'read_practice_candidates',
        load: () =>
          import('./tools/practice-candidates').then((m) => m.readPracticeCandidatesTool),
      },
    ],
  },
};
