// 作答与判分 owner 的 manifest 片段，由根 `manifest.ts` 组合。
import { API_ERROR_RESPONSES, ApiIdParamsSchema } from '@/kernel/http-contracts';
import type { CapabilityManifest } from '@/kernel/manifest';
import {
  CreateSubmissionBodySchema,
  IssuanceCreatedSchema,
  IssuanceParamsSchema,
  IssuanceStateSchema,
  IssueAssessmentBodySchema,
  JudgeDurablePendingResponseSchema,
  JudgeRunStatusResponseSchema,
  SaveResponseDraftBodySchema,
  SaveResponseDraftResponseSchema,
  StudyReferenceResponseSchema,
  SubmissionCreatedSchema,
} from '../api/assessment-contracts';
import { AttemptResponseSchema, CreateAttemptBodySchema } from '../api/contracts';

export const gradingManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
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
      'experimental:assessment_attempt',
      // 未作答录入与记录捕获写这个事件。声明放在练习侧，回来唤醒才能订阅，
      // 只挂练习的组合也不会报 undeclared action。
      'experimental:record_capture',
      'experimental:judge_calibration_sample',
      'experimental:judge_calibration_run_summary',
      'experimental:mastery_progress',
      // YUK-777 A2 — durable judge 面「作答已录、判词未落」的不可变证据。写者只有 submit
      // 面的 enqueueDurableJudge；消费者是 judge_pending_reconcile sweeper 与 submit 的
      // late-arrival guard（server/judge-run-dispatch.ts）。
      'experimental:judge_pending_attempt',
    ],
  },
  api: {
    routes: [
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
        // YUK-594 (durable judge main path, W1) — poll-tier status snapshot for a
        // durable judge_run (D2 three-tier backfill: SSE + poll + replay). Read-only
        // Permanent native completion/disposition precedes engine observation. The 202-pending
        // contract's poll_url points here (submit.ts enqueueDurableJudge).
        method: 'GET',
        path: '/api/jobs/judge_run/[id]/status',
        operationId: 'getJudgeRunStatus',
        request: { params: ApiIdParamsSchema },
        responses: { 200: JudgeRunStatusResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/judge-run-status-route').then((m) => m.GET),
      },
      // YUK-1052 — 统一发题/提交/自动保存（issueAssessment + saveSubmission +
      // D11 pinned-issuance 自动保存）。preselected ≠ issued：只有本路由实际
      // 落 assessment_issuance 行才算发题（不可变 revision/材料/呈现顺序绑定）。
      {
        method: 'POST',
        path: '/api/issuances',
        operationId: 'createIssuance',
        request: { body: IssueAssessmentBodySchema },
        responses: {
          200: IssuanceCreatedSchema,
          201: IssuanceCreatedSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () => import('./api/assessment-route').then((m) => m.createIssuance),
      },
      {
        // pending 恢复读面：issuance + live draft + 已接收提交。
        method: 'GET',
        path: '/api/issuances/[id]',
        operationId: 'getIssuance',
        request: { params: IssuanceParamsSchema },
        responses: { 200: IssuanceStateSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/assessment-route').then((m) => m.getIssuance),
      },
      {
        // D11 服务端自动保存：全练习面（solo/paper/placement）在 pinned
        // issuance 上自动保存；ack 只在落库后产生（saved 200）。
        method: 'POST',
        path: '/api/issuances/[id]/responses',
        operationId: 'saveResponseDraft',
        request: { params: IssuanceParamsSchema, body: SaveResponseDraftBodySchema },
        responses: { 200: SaveResponseDraftResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/assessment-route').then((m) => m.saveDraft),
      },
      {
        // 正式提交：同 (group,idempotency_key) 幂等 —— 一致 replay(200) /
        // 不同 conflict(409)；submission 绑定不可变 revision（不回取 latest）。
        method: 'POST',
        path: '/api/submissions',
        operationId: 'createSubmission',
        request: { body: CreateSubmissionBodySchema },
        responses: {
          200: SubmissionCreatedSchema,
          201: SubmissionCreatedSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: [200, 201],
        load: () => import('./api/assessment-route').then((m) => m.createSubmission),
      },
      {
        method: 'POST',
        path: '/api/issuances/[id]/reference-reveals',
        operationId: 'revealStudyReference',
        request: { params: IssuanceParamsSchema },
        responses: { 200: StudyReferenceResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/assessment-route').then((m) => m.revealStudyReference),
      },
    ],
  },
  jobs: {
    handlers: [
      // YUK-594 (durable judge main path, W1) — durable judge_run（异步为主路径）。
      // YUK-870 (F3.5b) — 注册自中央渐缩簿收编：includeMetadata:true 读
      // retryCount 驱动跨 provider lane 决策（D9），2s polling 与原中央行等价。
      {
        name: 'judge_run',
        backend: 'dbos',
        queue: 'llm',
        pollingIntervalSeconds: 2,
        batchSize: 1,
        includeMetadata: true,
      },
      // YUK-777 A3 — durable judge 的 domain-state-scan reconcile sweeper。扫「作答已录、
      // 判词未落」的 pending attempt，经同一 rate-limited 入队面重投 judge_run。自身不做
      // LLM 调用（付费发生在 judge_run），故 fast 层。
      {
        name: 'judge_pending_reconcile',
        backend: 'dbos',
        schedule: {
          cron: '50 * * * *',
          tz: 'Asia/Shanghai',
          singletonKey: 'judge_pending_reconcile-sweep',
          singletonSeconds: 60 * 60,
        },
        queue: 'fast',
      },
      // YUK-1496 C2（G3 模型判分准入，migration 线）— 留出题准入 run：冻结
      // 留出题集（每科 ≥30、带独立参考分）过生产同源判分端口，逐题 agreement
      // / severe error 落事件证据；阈值全过且非 dry run 才登记已准入切片。
      // 付费 job（真实模型调用），由 lead 在周预算内触发；无 schedule。
      {
        name: 'model_slice_admission_run',
        queue: 'llm',
        pollingIntervalSeconds: 2,
        batchSize: 1,
        load: () =>
          import('./jobs/model_slice_admission_run').then(
            (m) => m.buildModelSliceAdmissionRunHandler,
          ),
      },
      // YUK-573 — judge 校准不同意率采样（report-only）。付费 job，按需入队、无
      // schedule（同 model_slice_admission_run）；kill switch
      // JUDGE_CALIBRATION_SAMPLING_ENABLED 默认 OFF 时入队也 no-op、零 spend。复判走
      // 第二 lane（per-call ctx.override=anthropic-sub，绝不翻全局 AI_PROVIDER_OVERRIDE）。
      // queue:'agent'（EXPIRE_AGENT=7200s）：批内 ≤BATCH_MAX（默认 20）次 LLM 复判调用，
      // 是多次调用批任务，非单-shot 'llm' 档。幂等由 MF8 partial unique index
      // （drizzle/0059）DB 层强制，expire 窗重投递安全。
      {
        name: 'judge_calibration_sample',
        queue: 'agent',
        load: () =>
          import('./jobs/judge_calibration_sample').then(
            (m) => m.buildJudgeCalibrationSampleHandler,
          ),
      },
    ],
  },
  copilotTools: {
    tools: [
      {
        name: 'submit_review_answer',
        load: () => import('./tools/submit-review-answer').then((m) => m.submitReviewAnswerTool),
      },
    ],
  },
};
