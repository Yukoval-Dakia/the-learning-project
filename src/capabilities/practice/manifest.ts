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
  ui: { pages: [{ route: '/practice' }] },
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
