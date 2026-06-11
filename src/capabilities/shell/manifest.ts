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
    ],
  },
});
