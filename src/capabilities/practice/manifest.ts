import { defineCapability } from '@/kernel/manifest';

export const practiceCapability = defineCapability({
  name: 'practice',
  description:
    '练习消费侧：FSRS 传感器、判分评级、卷（paper）机制与会话编排。M2 加入流编排器与卷架（YUK-316）。',
  api: {
    // M2-T1 (YUK-316)：18 条路由全部带 load 懒加载 thunk（M1 配方）。[id]/[sid]
    // 段由 server/app.ts 的 toHonoPath 转 :id/:sid 并把捕获参数透传 handler。
    // 注：/api/practice/[id]/answer 实际是 POST（P2a 声明误写 PUT，壳与包从来是 POST）。
    routes: [
      {
        method: 'POST',
        path: '/api/review/submit',
        load: () => import('./api/submit').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/review/due',
        load: () => import('./api/due').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/advice',
        load: () => import('./api/advice').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/review/weekly',
        load: () => import('./api/weekly').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/appeal',
        load: () => import('./api/appeal').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/review/plan',
        load: () => import('./api/plan').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/sessions',
        load: () => import('./api/sessions').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/pause',
        load: () => import('./api/session-pause').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/resume',
        load: () => import('./api/session-resume').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/end',
        load: () => import('./api/session-end').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/sessions/[id]/reopen',
        load: () => import('./api/session-reopen').then((m) => m.POST),
      },
      // YUK-402 inc-4a — owner manual gate (draft 池审核面)后端。list draft pool +
      // enable (normal B5 verify→promote) + force-enable (override + reason 留痕)。
      // gate op = verifyAndPromote (src/server/quiz/verify-and-promote.ts)；/api/*
      // 自动套 internal-token。审核面属练习消费侧（draft 是 practice-pool 题）。
      {
        method: 'GET',
        path: '/api/review/drafts',
        load: () => import('./api/review-drafts-list').then((m) => m.GET),
      },
      // YUK-403 inc-4b — full-text draft preview (loom preview pane data source).
      {
        method: 'GET',
        path: '/api/review/drafts/[id]',
        load: () => import('./api/review-draft-detail').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/review/drafts/[id]/enable',
        load: () => import('./api/review-draft-enable').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/review/drafts/[id]/force-enable',
        load: () => import('./api/review-draft-force-enable').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/practice',
        load: () => import('./api/papers-list').then((m) => m.GET),
      },
      {
        // 开卷：start a review session bound to a paper artifact（M2-T6 补登：
        // handler 随 P2a 已迁入 papers-list.ts，manifest 此前漏了 POST 条目）。
        method: 'POST',
        path: '/api/practice',
        load: () => import('./api/papers-list').then((m) => m.POST),
      },
      {
        // M2 流编排器（YUK-316）。静态段 'stream' 在 Hono 中优先于 :id 匹配。
        method: 'GET',
        path: '/api/practice/stream',
        load: () => import('./api/stream').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/practice/stream/recompose',
        load: () => import('./api/stream').then((m) => m.POST),
      },
      {
        method: 'PATCH',
        path: '/api/practice/stream/items/[id]',
        load: () => import('./api/stream').then((m) => m.PATCH),
      },
      {
        method: 'GET',
        path: '/api/practice/[id]',
        load: () => import('./api/paper-detail-route').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/practice/[id]/submit',
        load: () => import('./api/paper-submit-route').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/practice/[id]/answer',
        load: () => import('./api/paper-answer-route').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve',
        load: () => import('./api/solve-start').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve/[sid]/submit',
        load: () => import('./api/solve-submit').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/questions/[id]/solve/[sid]/hint',
        load: () => import('./api/solve-hint').then((m) => m.POST),
      },
      // M5-T5a (YUK-321) — 题库 CRUD（D16 出 M2 范围，留旧栈至 M5 收口——
      // vite.config M2 注释——现收编）。
      {
        method: 'GET',
        path: '/api/questions',
        load: () => import('./api/questions-list').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/questions/[id]',
        load: () => import('./api/question-detail').then((m) => m.GET),
      },
      {
        method: 'PATCH',
        path: '/api/questions/[id]',
        load: () => import('./api/question-detail').then((m) => m.PATCH),
      },
      {
        method: 'DELETE',
        path: '/api/questions/[id]',
        load: () => import('./api/question-detail').then((m) => m.DELETE),
      },
    ],
  },
  jobs: {
    // M4-T3 (YUK-319)：practice 域 job 归属声明。review_plan 链式/按需
    // （coach_daily 跑完 boss.send 链投 + on-demand 重跑），无 cron（D5:29
    // 「不要另开独立 cron」）；handler 本体随 T3 迁入 ./jobs/review_plan。
    // rejudge（M2/D15 申诉自动重判）注册留在 handlers.ts 渐缩簿：其注册形态
    // 是非默认 1s polling + inline 动态 import handleRejudge（非 buildXHandler
    // 工厂），不走注册器统一配方——此处声明无 load 纯归属元数据。
    handlers: [
      {
        name: 'review_plan',
        queue: 'llm',
        load: () => import('./jobs/review_plan').then((m) => m.buildReviewPlanHandler),
      },
      { name: 'rejudge', queue: 'llm' },
      // B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask 冷启先验 backfill。夜间扫
      // 无 item_calibration 硬轨 row 的题，逐题估 b 写锚（出题 + 录入两条路径产生
      // 的新题都被此 job 兜住，无需每条创建路径埋 hook）。cron 错开其它夜链 job。
      {
        name: 'item_prior_backfill',
        schedule: { cron: '20 4 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/item_prior_backfill').then((m) => m.buildItemPriorBackfillHandler),
      },
      // YUK-361 Phase 4 (Task 9) — hybrid 运行时夜间预产 job。每夜（用户晨起前）为「今天」
      // 预产练习流，省去首读 lazy compose 的 LLM 网络往返。cron 5:30 Asia/Shanghai：错开
      // 既有夜链 job（最晚 item_prior_backfill 4:20 / agency goal_scope 4:30），且在数据
      // 预产链（item_prior / mastery 夜链）之后跑，让选题信号（θ̂ / b 锚）已新鲜。queue=llm：
      // softmax_mfi 默认路径会调 SelectionOrchestratorTask（LLM 编排），与 item_prior 同档。
      // 幂等由 composeNightly 的单飞锁 + 双重检查保证（夜产后用户首读 lazy 命中 no-op）。
      {
        name: 'practice_stream_compose_nightly',
        schedule: { cron: '30 5 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/practice_stream_compose_nightly').then(
            (m) => m.buildStreamComposeNightlyHandler,
          ),
      },
      // YUK-372 L5 (YUK-361 Phase 8 wire-up) — 供给目标发现 + 派发夜扫。确定性缺口扫描
      // （discoverSupplyTargets，零写零 LLM）→ dispatchSupplyTargets 派到既有 sourcing /
      // quiz_gen 队列或标 manual。cron 06:00 Asia/Shanghai：错开并排在所有数据预产 job 之后
      // （item_prior 04:20 / mastery 夜链 / compose 05:30），让前沿/题池信号已新鲜、缺口判定准。
      // queue=llm：派出的 sourcing / quiz_gen 本身是 LLM 重型 job，本 job 与其同档 DLQ 重试。
      // **成本护栏**：dispatcher 的 7d fingerprint cooldown 是唯一防 job-spam 闸（同未满足缺口
      // 7 天内只真派一次）；本 job 依赖它，绝不绕过 dispatcher 直发付费队列。
      {
        name: 'question_supply_nightly',
        schedule: { cron: '0 6 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/question_supply_nightly').then((m) => m.buildQuestionSupplyNightlyHandler),
      },
      // YUK-372 L1 (YUK-361 Phase 6 wire-up, ADR-0043 §4) — active-PPI 难度重标定触发器。
      // recalibrateQuestion（建好但 Phase 6 无生产 caller 的离线 b 去偏引擎）的夜间触发：每夜扫
      // 「攒够标签 + 昨日起窗内有新标签」的非 draft 题，逐题 firm-up b_calib（track='hard'）。
      // cron 04:50 Asia/Shanghai：错在 item_prior 04:20 之后、compose 05:30 之前——这样今晨 firm
      // 的 b_calib 被当天 compose 的选题信号读到。queue=llm：与其它慢热 job 同档 DLQ 重试（慢资产
      // 写慢，给重试余量）。recalibrateQuestion 在 job 顶层调（非 attempt tx 内），per-question
      // try/catch 隔离单题失败，不加 SAVEPOINT（G1）。
      {
        name: 'recalibration_nightly',
        schedule: { cron: '50 4 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/recalibration_nightly').then((m) => m.buildRecalibrationNightlyHandler),
      },
      // YUK-383 Phase 0 — 语义 embedding 地基 backfill。每夜嵌入 embedding IS NULL
      // 的 question + knowledge 行（存量 backfill + 次日新行 + embed-API 故障重试，
      // §9 fallback）。cron 04:40 Asia/Shanghai：错开既有夜链——item_prior 04:20、
      // recalibration 04:50、compose 05:30、supply 06:00（agency goal_scope 04:30）。
      // queue=llm：与其它慢热 backfill job 同档 DLQ 重试。幂等由 embedding IS NULL
      // 过滤保证（无 NULL 行 = no-op）；embedMany throw 留 NULL 下轮重试，不阻塞入库。
      {
        name: 'embed_backfill',
        schedule: { cron: '40 4 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () => import('./jobs/embed_backfill').then((m) => m.buildEmbedBackfillHandler),
      },
      // YUK-390 kind Step 3 — answer_class materialization backfill. Classifies
      // answer_class IS NULL question rows via deriveAnswerClass (pure, no API),
      // for retrieval filtering + the kind reshape. cron 05:00 Asia/Shanghai: a
      // clear slot after the nightly chain (embed 04:40 / recalibration 04:50,
      // before compose 05:30). No dependency on other jobs (pure derivation).
      // queue=llm: shares the established backfill DLQ/retry bucket. Idempotent via
      // the answer_class IS NULL filter (no NULL rows = no-op).
      {
        name: 'answer_class_backfill',
        schedule: { cron: '0 5 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/answer_class_backfill').then((m) => m.buildAnswerClassBackfillHandler),
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
      { kind: 'variant_question' },
      { kind: 'question_draft' },
      { kind: 'judge_retraction' },
      { kind: 'question_edit' },
    ],
  },
  // M2-T6 将把旧 /review、/practice 页重生为单一练习面 /practice（流+卷架）。
  // inc-4b (YUK-403) — owner manual gate 草稿审核面 /drafts（draft 是 practice-pool 题）。
  // YUK-409 — 题库面 /questions（loom screen-questions）+ 题详情 stub /questions/:id。
  ui: {
    pages: [
      { route: '/practice' },
      { route: '/drafts' },
      { route: '/questions' },
      { route: '/questions/:id' },
    ],
  },
  // M5-T3 (YUK-321) — copilot 工具归属声明（题/错题/复习读 4 + 出题组卷写 3）。
  // ADR-0032 D6-B (YUK-203 lane L6) 追加 propose_question_edit（active 题结构编辑写）。
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
