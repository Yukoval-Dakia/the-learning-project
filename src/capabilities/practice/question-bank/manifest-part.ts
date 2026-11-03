// 题库与准入 owner 的 manifest 片段，由根 `manifest.ts` 组合。
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import type { CapabilityManifest } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';
import {
  FixedAnchorBodySchema,
  FixedAnchorResponseSchema,
} from './api/calibration-anchors-contracts';
import {
  DraftForceEnableBodySchema,
  DraftModerationParamsSchema,
  DraftPromotionResponseSchema,
  DraftReviewDetailResponseSchema,
  DraftReviewListQuerySchema,
  DraftReviewListResponseSchema,
} from './api/draft-moderation-contracts';
import {
  DeleteQuestionQuerySchema,
  DeleteQuestionResponseSchema,
  QuestionDetailQuerySchema,
  QuestionDetailResponseSchema,
  QuestionListQuerySchema,
  QuestionListResponseSchema,
  QuestionParamsSchema,
  QuestionServingActionHeadersSchema,
  QuestionServingActionParamsSchema,
  QuestionServingActionResponseSchema,
  RestoreQuestionBodySchema,
  RestoreQuestionResponseSchema,
  UpdateQuestionBodySchema,
  UpdateQuestionResponseSchema,
} from './api/question-contracts';

export const questionBankManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
  events: {
    actions: [
      // YUK-1514 — serving-hold command ledger (system reverify /
      // recheck_source, user release_verify_hold); the per-key idempotency +
      // pending_action anchor.
      'experimental:question_serving_action',
      // Quiz draft verification ledger. Agency subscribes and turns a committed
      // non-promotion into a coach pool-gap hint; the verify job does not call Agency.
      'experimental:quiz_verify',
    ],
  },
  subscriptions: {
    handlers: [
      {
        // Admission verdicts and source_verify suspends both land on the declared
        // assessment_publish action; the handler re-checks the hold through the same
        // paid-effect command path (auto ledger key).
        id: 'practice.serving-recheck',
        version: 1,
        actions: ['experimental:assessment_publish'],
        load: () =>
          import('./server/serving-recheck-subscription').then(
            (m) => m.buildServingRecheckSubscriber,
          ),
      },
      {
        id: 'practice.question-admission-enqueue',
        version: 1,
        actions: ['experimental:assessment_publish'],
        load: () =>
          import('./server/admission/enqueue').then((m) => m.buildQuestionAdmissionSubscriber),
      },
    ],
  },
  api: {
    routes: [
      // YUK-402 inc-4a — owner manual gate (draft 池审核面)后端。list draft pool +
      // enable (normal B5 verify→promote) + force-enable (override + reason 留痕)。
      // gate op = verifyAndPromote (server/quiz/verify-and-promote.ts)；/api/*
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
      {
        // YUK-1045 — archive 的对偶：恢复 = withdrawn 复位 + 原子重取 claim。
        // UI slice 是 YUK-1051 lane；本端点先落地契约（幂等/冲突语义确定）。
        method: 'POST',
        path: '/api/questions/[id]/restore',
        operationId: 'restoreQuestion',
        request: { params: QuestionParamsSchema, body: RestoreQuestionBodySchema },
        responses: { 200: RestoreQuestionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/question-restore').then((m) => m.POST),
      },
      {
        // YUK-1514 — serving-hold release commands. YUK-1664: only
        // release_verify_hold stays a user command; reverify / recheck_source
        // run through the system ledger and now parse-fail here (4xx).
        // Idempotency-Key required; {accepted, serving}.
        method: 'POST',
        path: '/api/questions/[id]/serving-actions/[command]',
        operationId: 'runQuestionServingAction',
        request: {
          params: QuestionServingActionParamsSchema,
          headers: QuestionServingActionHeadersSchema,
        },
        responses: { 200: QuestionServingActionResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/question-serving-actions').then((m) => m.POST),
      },
      // YUK-453 (cold-start inc-A) — owner FIXED-ANCHOR write face. owner 钦定 ~5-10 道
      // 锚题的难度档（粗分桶）→ item_calibration source='fixed_anchor'。n=1 唯一不违红线
      // 的「校 LLM 难度系统性 offset」杠杆（cold-start day-one design §5 inc-A / §4.1）。
      // 写真身在 ./server/fixed-anchor.ts（fold sanctioned off-path writer）；handler
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
    handlers: [
      // YUK-868 — verification + promotion jobs owned by Practice. Queue tiers
      // mirror the retired central registrations byte-for-byte (quiz_verify /
      // source_verify were EXPIRE_AGENT → 'agent'; variant_verify was EXPIRE_LLM
      // → 'llm'); worker options come from the registrar default {2s, batchSize 1},
      // which is exactly what handlers.ts used to pass explicitly.
      {
        name: 'quiz_verify',
        queue: 'agent',
        load: () => import('./jobs/quiz_verify').then((m) => m.buildQuizVerifyHandler),
      },
      {
        name: 'source_verify',
        queue: 'agent',
        load: () => import('./jobs/source_verify').then((m) => m.buildSourceVerifyHandler),
      },
      {
        // YUK-17 / ADR-0018 — second-pass content alignment check for accepted
        // variants. Enqueued by acceptAiProposal after a variant_question proposal
        // is accepted; verdict='fail' flips mistake_variant.status to 'broken'.
        name: 'variant_verify',
        queue: 'llm',
        load: () => import('./jobs/variant_verify').then((m) => m.buildVariantVerifyHandler),
      },
      // B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask 冷启先验 backfill。夜间扫
      // 无 item_calibration 硬轨 row 的题，逐题估 b 写锚（出题 + 录入两条路径产生
      // 的新题都被此 job 兜住，无需每条创建路径埋 hook）。
      {
        // YUK-758 DAG 成员（根）：item_calibration b 锚**种子**写者。recalibration 在其后 firm-up
        // 同表后验列 → item_prior 是 recalibration 的硬上游（写序：种子先、标定后）。cron 移除。
        name: 'item_prior_backfill',
        dependsOn: [],
        eligibility: nightlyEligibility('deterministic', { usesModel: true }),
        queue: 'llm',
        load: () =>
          import('./jobs/item_prior_backfill').then((m) => m.buildItemPriorBackfillHandler),
      },
      // YUK-439 (ADR-0043 2026-10-19 Amendment A2/A3) — 联合标定批的夜间触发器（原
      // YUK-372 L1 的 active-PPI firm-up 触发器改喂连续后验批）。每夜对「有证据且
      // stale（窗内新证据 / calibration_n ≠ 证据行数 / 尚非 joint）」的非 draft 题从
      // 证据账本全量重算后验 b_post（track='hard'）——证据从第一条起连续收缩，无 12
      // 标签跳变（A3）；批边界跑 KB 漂移审计（A5）。排在 item_prior 之后、compose/
      // supply 之前——今晨收敛的 b_post 被当天的选题与缺口扫描读到；YUK-758 起该次序
      // 由 dependsOn 硬边保证。queue=llm：慢资产写慢，同档 DLQ 重试。批函数在 job
      // 顶层调（非 attempt tx 内），per-question try/catch 隔离单题失败（G1）。
      {
        // YUK-758 DAG 成员：收敛 item_calibration.b_post（track='hard'，联合标定后验）。
        // 对 item_prior_backfill 是硬边（同表 b 锚：种子先、后验后），且是 compose 选题
        // 实读的最终标定态上游。cron 移除。
        name: 'recalibration_nightly',
        dependsOn: ['item_prior_backfill'],
        eligibility: nightlyEligibility('deterministic'),
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
        eligibility: nightlyEligibility('hygiene_embed'),
        queue: 'llm',
        load: () => import('./jobs/embed_backfill').then((m) => m.buildEmbedBackfillHandler),
      },
      // YUK-489 (P4a) — reference-answer backfill. P3 decoupled cold-start-bridge ③
      // (reference generation) from KC tagging: a prompt-only OCR question persists
      // with reference_md IS NULL (auto-enroll). This job
      // fills those nulls nightly + independently, REUSING generateReferenceSolution
      // (no new task). Trigger = reference_md IS NULL AND ≥1 knowledge_id (resolvable
      // subject); no-knowledge_id rows are skipped. cron 05:20 Asia/Shanghai is
      // independent of the nightly DAG. queue=llm:
      // generateReferenceSolution runs SolutionGenerateTask (LLM) — same DLQ/retry bucket
      // as the other slow backfills. Idempotent via the reference_md IS NULL filter
      // (no NULL rows = no-op); a per-row solver skipped_error leaves the row NULL for
      // the next run, the batch continues (embed_backfill per-row contract).
      {
        name: 'reference_answer_backfill',
        schedule: { cron: '20 5 * * *', tz: 'Asia/Shanghai' },
        eligibility: nightlyEligibility('deterministic', { usesModel: true }),
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
        eligibility: nightlyEligibility('deterministic'),
        queue: 'llm',
        load: () =>
          import('./jobs/answer_class_backfill').then((m) => m.buildAnswerClassBackfillHandler),
      },
      // YUK-1445 — 入库准入（G1 双盲解题一致 + G2 逐单元标定）的 live consumer：
      // 对既有 draft/revision（question_id 或 revision_id）跑 runQuestionAdmission
      // 已知结果经发布 seam 落 admitted/withheld；未知保留 durable obligation。
      // 单次 admission = 2×solve（+1×crosscheck）LLM 调用 → 'llm' 档；
      // pending admission 的发布事件经上方 subscriber 在事务内入队；恢复不重付。
      {
        name: 'question_admission_run',
        queue: 'llm',
        load: () =>
          import('./jobs/question_admission_run').then((m) => m.buildQuestionAdmissionRunHandler),
      },
    ],
  },
  // M4-T4 (YUK-319)：proposal kind 归属声明。variant_question / question_draft
  // 的 accept applier 真身在 ./server/proposal-appliers。
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
        // YUK-308 — dismiss tombstones the still-draft question row
        // (metadata.dismissed_at) so a rejected draft stops reading as a live
        // pending draft to search_bank / write_quiz / the draft-review pool.
        dismiss: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.questionDraftProposalDismissApplier,
            ),
        },
      },
      // YUK-1407 — judge_retraction accept applier 落地：evaluation 目标走既有
      // appeal/rejudge/CAS 激活 + settlement replay 链（可逆，不回写原评价）；
      // legacy judge-event 目标写 CorrectEvent(retract)。结算 owner 落位前，它的
      // 登记跟着装载入口 proposal-accept-applier 走（设计 §3.1）。
      {
        kind: 'judge_retraction',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.judgeRetractionProposalAcceptApplier,
            ),
        },
      },
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
  copilotTools: {
    tools: [
      {
        name: 'author_question',
        load: () => import('./tools/proposal-tools').then((m) => m.authorQuestionTool),
      },
      // YUK-1468 — 统一题目编辑面（v2 草稿文档 ops/CAS/幂等/validate/probe）。
      {
        name: 'edit_question',
        load: () => import('./tools/edit-question').then((m) => m.editQuestionTool),
      },
      {
        name: 'search_bank',
        load: () => import('./tools/search-bank').then((m) => m.searchBankTool),
      },
      {
        name: 'read_bank',
        load: () => import('./tools/read-bank').then((m) => m.readBankTool),
      },
      {
        name: 'check_bank',
        load: () => import('./tools/check-bank').then((m) => m.checkBankTool),
      },
      // YUK-1468 — `propose_question_edit` 保留在 inventory 但【无 surface
      // 授权】：Copilot 调 edit_question（工具按 caller surface 自动落
      // question_edit proposal，accept 走同一 ops→submit gate）。壳模块
      // 与测试在 owner 批准删除后随独立 PR 清理。
      {
        name: 'propose_question_edit',
        load: () => import('./tools/proposal-tools').then((m) => m.proposeQuestionEditTool),
      },
    ],
  },
};
