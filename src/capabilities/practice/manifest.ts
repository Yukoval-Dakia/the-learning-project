import { QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION } from '@/core/schema/event';
import { API_ERROR_RESPONSES, ApiErrorResponseSchema } from '@/kernel/http-contracts';
import { type CapabilityManifest, defineCapability } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import { CoverageLatticeResponseSchema } from './api/coverage-lattice-contracts';
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
  events: {
    actions: [
      'experimental:confirmation_assessment',
      'experimental:confirmation_original',
      // Native head transitions are the authoritative trigger for diagnostic consumers.
      'experimental:assessment_activation',
      'experimental:assessment_publish',
      'experimental:hint_request',
      // Inference only: repeated independent wrongs against independent corrects
      // on other admitted questions of the same KC. Not a serving hold.
      QUESTION_OR_ANSWER_MAY_BE_FAULTY_ACTION,
      ...fromOwnerParts((part) => part.events?.actions),
    ],
  },
  subscriptions: { handlers: fromOwnerParts((part) => part.subscriptions?.handlers) },
  api: {
    // M2-T1 (YUK-316)：18 条路由全部带 load 懒加载 thunk（M1 配方）。[id]/[sid]
    // 段由 server/app.ts 的 toHonoPath 转 :id/:sid 并把捕获参数透传 handler。
    // 注：/api/practice/[id]/answer 实际是 POST（P2a 声明误写 PUT，壳与包从来是 POST）。
    routes: [
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
      ...fromOwnerParts((part) => part.copilotTools?.tools),
    ],
  },
});
