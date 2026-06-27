import { defineCapability } from '@/kernel/manifest';

// M4-T5 (YUK-319/YUK-318)：shell 包——跨域工作台壳层。提议收件箱三路由源自
// 旧 Next app/api/proposals/* 等价平移（accept+dismiss 合并为单 decide 端点，
// kind query 是 YUK-318 收口增量）；workbench/summary 是 today 重生聚合
// （新端点，不受搬迁红线约束）。
export const shellCapability = defineCapability({
  name: 'shell',
  description:
    '工作台壳层：跨域提议收件箱（统一 /api/proposals 列表 + decide/retract 决策面，' +
    '17 kind 全量）与工作台聚合（/api/workbench/summary——提议 KPI / due / 待归因 / ' +
    '知识量 / 进行中会话 / 7 天活动热力；spec M4 验收「夜间跑完，早上工作台有交班条' +
    '与待审提议」的读模型）。',
  api: {
    routes: [
      {
        method: 'GET',
        path: '/api/proposals',
        load: () => import('./api/proposals-list').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/proposals/[id]/decide',
        load: () => import('./api/proposal-decide').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/proposals/[id]/retract',
        load: () => import('./api/proposal-retract').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/workbench/summary',
        load: () => import('./api/workbench-summary').then((m) => m.GET),
      },
      // YUK-406 / YUK-440 (教研团 Phase 0 / U4 备课台) — top ≤3 pending conjecture
      // 读模型（salience 排序，confidence 永不过线）。
      {
        method: 'GET',
        path: '/api/prep-desk/conjectures',
        load: () => import('./api/prep-desk-conjectures').then((m) => m.GET),
      },
    ],
  },
  // M4-T6 (YUK-319)：工作台 + 收件箱两 surface；todayBlocks 是工作台自有块
  //（agency 的 agent-notes-board、notes 的 ai-changes-strip 各自声明）。
  // M5-T4b (YUK-321)：+/coach（spec §3.6「Coach 周报 keep · 归工作台/复盘面」）；
  // +cost-ribbon todayBlock（CostRibbon 接通 /api/cost/today，observability 端点）。
  ui: {
    pages: [{ route: '/today' }, { route: '/inbox' }, { route: '/coach' }],
    todayBlocks: [
      'loom-hero',
      'kpi-row',
      'sessions-strip',
      'proposal-strip',
      'cost-ribbon',
      'week-heat',
    ],
  },
});
