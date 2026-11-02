import { QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION } from '@/core/schema/event';
import {
  API_ERROR_RESPONSES,
  ApiErrorResponseSchema,
  ApiIdParamsSchema,
} from '@/kernel/http-contracts';
import { type CapabilityManifest, defineCapability } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import {
  CreateSubmissionBodySchema,
  IssuanceCreatedSchema,
  IssuanceParamsSchema,
  IssuanceStateSchema,
  IssueAssessmentBodySchema,
  SaveResponseDraftBodySchema,
  SaveResponseDraftResponseSchema,
  StudyReferenceResponseSchema,
  SubmissionCreatedSchema,
} from './api/assessment-contracts';
import {
  AppealResponseSchema,
  AttemptResponseSchema,
  CreateAppealBodySchema,
  CreateAttemptBodySchema,
} from './api/contracts';
import { CoverageLatticeResponseSchema } from './api/coverage-lattice-contracts';
import {
  CreatePlacementHeldReleaseBodySchema,
  CreatePlacementQuestionSelectionBodySchema,
  CreatePlacementSessionBodySchema,
  PlacementHeldReleaseResponseSchema,
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
  QuizGenTriggerAcceptedSchema,
  QuizGenTriggerBodySchema,
} from './api/quiz-gen-trigger-contracts';
import {
  CreateHintRequestBodySchema,
  CreateSolveSessionBodySchema,
  CreateSolveSubmissionBodySchema,
  HintRequestResponseSchema,
  SolveSessionCreatedSchema,
  SolveSessionParamsSchema,
  SolveSessionResponseSchema,
  SolveSubmissionResponseSchema,
} from './api/solve-contracts';
import { failureLearningManifestPart } from './failure-learning/manifest-part';
import { gradingManifestPart } from './grading/manifest-part';
import { placementManifestPart } from './placement/manifest-part';
import { questionBankManifestPart } from './question-bank/manifest-part';
import { schedulingManifestPart } from './scheduling/manifest-part';
// YUK-594 (durable judge main path, W1) — judge_run poll-tier status + 202-pending schemas
// (live in the db-free judge-run-status module so this eager import stays db-light).
import {
  JudgeDurablePendingResponseSchema,
  JudgeRunStatusResponseSchema,
} from './server/judge-run-status';
import { sessionManifestPart } from './session/manifest-part';
import { settlementManifestPart } from './settlement/manifest-part';
import { supplyManifestPart } from './supply/manifest-part';

type OwnerManifestPart = Omit<CapabilityManifest, 'name' | 'description'>;

// 片段顺序就是各 owner 条目的注册顺序。Hono 按注册顺序匹配路由，scheduling 的
// `/api/practice/stream*` 必须先于 session 的 `/api/practice/[id]` 注册。
const OWNER_MANIFEST_PARTS: readonly OwnerManifestPart[] = [
  gradingManifestPart,
  settlementManifestPart,
  questionBankManifestPart,
  failureLearningManifestPart,
  schedulingManifestPart,
  sessionManifestPart,
  supplyManifestPart,
  placementManifestPart,
];

function fromOwnerParts<T>(pick: (part: OwnerManifestPart) => readonly T[] | undefined): T[] {
  return OWNER_MANIFEST_PARTS.flatMap((part) => pick(part) ?? []);
}

export const practiceCapability = defineCapability({
  name: 'practice',
  description:
    '练习消费侧：作答、判分、错因学习、针对性变式、FSRS 传感器、卷（paper）机制与会话编排。',
  // YUK-573 — judge 校准观测事件归属（report-only）：sample = 每条复判对照一行
  // （caused_by = 原 judge event，MF8 partial unique index 唯一化）；run_summary =
  // 每次 run 一行（mass-skip 自曝面）。写者只有 judge_calibration_sample job。
  events: {
    actions: [
      'experimental:confirmation_assessment',
      'experimental:confirmation_original',
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
      // Native head transitions are the authoritative trigger for diagnostic consumers.
      'experimental:assessment_activation',
      'experimental:assessment_publish',
      'experimental:assessment_attempt',
      // 未作答录入与记录捕获写这个事件。声明放在练习侧，回来唤醒才能订阅，
      // 只挂练习的组合也不会报 undeclared action。
      'experimental:record_capture',
      'experimental:assessment_placement_issued',
      // YUK-1405 L1 — learner-released held issuance (recorded unresolved).
      'experimental:assessment_placement_released',
      // YUK-1405 L2 — once-per-session marker: first "no servable item" outcome
      // with the real elapsed session→alternative time.
      'experimental:assessment_placement_no_item',
      'experimental:judge_calibration_sample',
      'experimental:judge_calibration_run_summary',
      'experimental:hint_request',
      'experimental:mastery_progress',
      // YUK-777 A2 — durable judge 面「作答已录、判词未落」的不可变证据。写者只有 submit
      // 面的 enqueueDurableJudge；消费者是 judge_pending_reconcile sweeper 与 submit 的
      // late-arrival guard（server/judge-run-dispatch.ts）。
      'experimental:judge_pending_attempt',
      // Inference only: repeated independent wrongs against independent corrects
      // on other admitted questions of the same KC. Not a serving hold.
      QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION,
      ...fromOwnerParts((part) => part.events?.actions),
    ],
  },
  subscriptions: {
    handlers: [
      {
        // YUK-1664 — admission verdicts and source_verify suspends both land on
        // the declared assessment_publish action; the handler re-checks the
        // hold through the same paid-effect command path (auto ledger key).
        id: 'practice.serving-recheck',
        version: 1,
        actions: ['experimental:assessment_publish'],
        load: () =>
          import('./server/serving-recheck-subscription').then(
            (m) => m.buildServingRecheckSubscriber,
          ),
      },
      ...fromOwnerParts((part) => part.subscriptions?.handlers),
    ],
  },
  api: {
    // M2-T1 (YUK-316)：18 条路由全部带 load 懒加载 thunk（M1 配方）。[id]/[sid]
    // 段由 server/app.ts 的 toHonoPath 转 :id/:sid 并把捕获参数透传 handler。
    // 注：/api/practice/[id]/answer 实际是 POST（P2a 声明误写 PUT，壳与包从来是 POST）。
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
      {
        method: 'POST',
        path: '/api/appeals',
        operationId: 'createAppeal',
        request: { body: CreateAppealBodySchema },
        responses: { 201: AppealResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/appeal').then((m) => m.createAppealResource),
      },
      // YUK-468 cold-start inc-B — placement probe 会话 API (dark-ship, gated on
      // PLACEMENT_PROBE_ENABLED). start → first question; [id]/next → terminate-check + next
      // question; [id]/end → complete/abandon. Answers now go through /api/attempts with the
      // probe's session_id (shared judge + θ̂ path, no separate placement submit).
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
      // YUK-1405 L1 — held item 的「继续」出口：记录未决（不算答错）并推进。
      // 「结束」出口走 PATCH /api/placement-sessions/[id]（unresolved_items）。
      {
        method: 'POST',
        path: '/api/placement-sessions/[id]/held-release',
        operationId: 'createPlacementHeldRelease',
        request: {
          params: PlacementSessionParamsSchema,
          body: CreatePlacementHeldReleaseBodySchema,
        },
        responses: { 200: PlacementHeldReleaseResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/placement-held-release').then((m) => m.POST),
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
      // YUK-605 ① + YUK-555 — owner manual quiz_gen trigger. The consumption entry
      // three code comments + ADR-0038 referenced but that never existed (the only
      // enqueue path was the nightly dispatcher). Thin route: real knowledge read
      // (empty → 404) → enqueue via the dispatcher's kernel path → 202 with job id.
      // count carries the YUK-555 two-layer guardrail (warn watermark informs; hard
      // cap 15 rejects — constants live in the db-light contracts module).
      {
        method: 'POST',
        path: '/api/questions/quiz-gen',
        operationId: 'triggerQuizGen',
        request: { body: QuizGenTriggerBodySchema },
        responses: {
          202: QuizGenTriggerAcceptedSchema,
          ...API_ERROR_RESPONSES,
          502: ApiErrorResponseSchema,
        },
        successStatus: 202,
        load: () => import('./api/quiz-gen-trigger').then((m) => m.POST),
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
      // Coverage facts are computed by Practice's supply scanner, so Practice owns their read:
      // scanCoverageGaps pool rules plus supply-event activity. Read-only, no LLM.
      {
        method: 'GET',
        path: '/api/admin/coverage-lattice',
        operationId: 'getCoverageLattice',
        responses: { 200: CoverageLatticeResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/coverage-lattice').then((m) => m.GET),
      },
      ...fromOwnerParts((part) => part.api?.routes),
    ],
  },
  jobs: {
    // M4-T3 (YUK-319)：practice 域 job 归属声明。（YUK-349：review_plan 链式
    // job 已随 B3 退役。YUK-870 F3.5b：rejudge / judge_run / session_summary
    // 三条注册自 handlers.ts 渐缩簿收编，practice 域自此无留簿注册。）
    handlers: [
      {
        name: 'quiz_gen',
        queue: 'agent',
        includeMetadata: true,
        load: () => import('./jobs/quiz_gen').then((m) => m.buildQuizGenHandler),
      },
      // YUK-870 (F3.5b) — rejudge 注册自中央渐缩簿收编（等价平移红线：LLM 档
      // 1h expire + DLQ、非默认 1s polling、batchSize 1——原中央行的 inline 动态
      // import + handleRejudge 循环 flatten 成 jobs/rejudge.ts 的标准工厂）。
      {
        name: 'rejudge',
        queue: 'llm',
        pollingIntervalSeconds: 1,
        batchSize: 1,
        load: () => import('./jobs/rejudge').then((m) => m.buildRejudgeHandler),
      },
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
      // YUK-986 (Supply-Agent/1) — jyeoo staged 图片资产回收。jyeoo_fetch_candidates
      // 即期持久化候选图片（origin='jyeoo_staged'），未提交候选的孤儿资产每日回收
      // （宽限 24h）。无 LLM、无外部调用，fast 层。
      {
        name: 'jyeoo_staged_asset_reap',
        schedule: {
          cron: '40 3 * * *',
          tz: 'Asia/Shanghai',
          singletonKey: 'jyeoo_staged_asset_reap-sweep',
          singletonSeconds: 60 * 60,
        },
        queue: 'fast',
        load: () =>
          import('./jobs/jyeoo_staged_asset_reap').then((m) => m.buildJyeooStagedAssetReapHandler),
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
      // YUK-987 (985/E2) — 供给需求层 planner agent。LLM 产出 SupplyPlanV1 需求计划，机器门
      // （schema/活KC/词表/去重/预算声明，supply-plan-gate.ts）校验后逐项 emit manual 需求
      // 留痕（E3 executor 未落地）。05:50 cron：在 recalibration 固化（DAG 04:50 起）之后、
      // question_supply_nightly（DAG ~06:00）之前。与 DAG 无硬边是设计使然：扫描器安全网必须
      // 能在 planner 失败/空计划时照常派发缺口（planner 不得拖死安全网）；反向也无边——
      // planner 读原始信号而非扫描器结论，需求独立形成，同 job 内跑 discoverSupplyTargets
      // 写 shadow 对比事件（YUK-698 Phase D 影子评估）。queue=llm：LLM burn 同档 DLQ 重试。
      {
        name: 'supply_planner',
        schedule: { cron: '50 5 * * *', tz: 'Asia/Shanghai' },
        eligibility: nightlyEligibility('deterministic', { usesModel: true }),
        queue: 'llm',
        load: () => import('./jobs/supply_planner').then((m) => m.buildSupplyPlannerHandler),
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
        eligibility: nightlyEligibility('deterministic', { usesModel: true }),
        queue: 'llm',
        load: () =>
          import('./jobs/confusable_contrast_nightly').then(
            (m) => m.buildConfusableContrastNightlyHandler,
          ),
      },
      // YUK-1560 删除 axis_state_nightly 夜写及 batch writer；learner_axis_state 只保留历史行（merge 时 rename/freeze）。
      // YUK-573 — judge 校准不同意率采样（report-only，dark-ship）。kill switch
      // JUDGE_CALIBRATION_SAMPLING_ENABLED 默认 OFF（cron 保持注册，handler no-op，
      // 零 spend）。复判走第二 lane（per-call ctx.override=anthropic-sub，绝不翻
      // 全局 AI_PROVIDER_OVERRIDE）。cron 06:10 Asia/Shanghai：夜间避开 owner
      // 交互期减 Max 订阅 rate-limit 争用（S2）。queue:'agent'（EXPIRE_AGENT=
      // 7200s）：批内 ≤BATCH_MAX（默认 20）次 LLM 复判调用，是多次调用批任务，
      // 非单-shot 'llm' 档。幂等由 MF8 partial unique index（drizzle/0059）DB 层
      // 强制，expire 窗重投递安全。
      {
        name: 'judge_calibration_sample',
        schedule: { cron: '10 6 * * *', tz: 'Asia/Shanghai' },
        eligibility: nightlyEligibility('deterministic', { usesModel: true }),
        queue: 'agent',
        load: () =>
          import('./jobs/judge_calibration_sample').then(
            (m) => m.buildJudgeCalibrationSampleHandler,
          ),
      },
      ...fromOwnerParts((part) => part.jobs?.handlers),
    ],
  },
  proposals: { kinds: fromOwnerParts((part) => part.proposals?.kinds) },
  ui: { pages: uiPagesFor('practice') },
  // M5-T3 / YUK-328 — 完整 DomainTool 归属声明（字段名沿用 copilotTools）。
  // attribute_mistake / propose_variant 仅由 user-suggested mistake-action surface 授权；
  // ADR-0032 D6-B 的 propose_question_edit 则属于 Copilot base surface。
  copilotTools: {
    tools: [
      {
        name: 'submit_review_answer',
        load: () =>
          import('./server/tools/submit-review-answer').then((m) => m.submitReviewAnswerTool),
      },
      {
        name: 'generate_question_candidate',
        load: () =>
          import('./server/tools/generate-question-candidate').then(
            (m) => m.generateQuestionCandidateTool,
          ),
      },
      // YUK-986 (Supply-Agent/1) — 供给 agent 化的 jyeoo fetch/commit 双 tool。
      // E1 只注册进 inventory（无任何 surface 授权）；E3（YUK-988）才把
      // jyeoo_fetch_candidates 授给 executor surface，store_sourced_question
      // 保持服务端/executor 专用。
      {
        name: 'jyeoo_fetch_candidates',
        load: () =>
          import('./server/tools/jyeoo-fetch-candidates').then((m) => m.jyeooFetchCandidatesTool),
      },
      // YUK-988 (Supply-Agent/3) — web 候选生产线 DomainTool（Tavily 检索 +
      // SourcingTask 抽取，candidate-only 不写库）。E3 只注册进 inventory（无任何
      // surface 授权，与 jyeoo_fetch_candidates 的 E1 先例同款）。
      {
        name: 'web_fetch_candidates',
        load: () =>
          import('./server/tools/web-fetch-candidates').then((m) => m.webFetchCandidatesTool),
      },
      // YUK-1448 (Stage 1 batch D) — search_bank 检索不足时的缺口落单工具：幂等登记
      // EvidenceDemandV1 + 检索约束到既有供题台账，再走现有 dispatcher；无法落实的
      // 限制返回 held/unsupported_constraint。授权面：copilot（COPILOT_TOOLS）；
      // supply_planner 保持只读挂载；不进 Maintenance。
      {
        name: 'file_bank_gap',
        load: () => import('./server/tools/file-bank-gap').then((m) => m.fileBankGapTool),
      },
      // YUK-1407 — 判分纠错提案工具（judge_retraction→evaluation）。授予
      // copilot/dreaming/coach 三个发现疑似误判的 agent 面（allowlists.ts）。
      {
        name: 'propose_grading_correction',
        load: () =>
          import('./server/tools/propose-grading-correction').then(
            (m) => m.proposeGradingCorrectionTool,
          ),
      },
      ...fromOwnerParts((part) => part.copilotTools?.tools),
    ],
  },
});
