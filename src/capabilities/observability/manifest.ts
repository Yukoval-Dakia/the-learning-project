import { defineCapability } from '@/kernel/manifest';

// M5-T4 (YUK-321) — observability 包：AI 运行可观测性（admin 四页数据面）+
// 今日成本条。核心实现 server/ai-observability.ts（纯 drizzle，整体迁自
// src/server/admin）。ui.pages 随 T4b（admin 四页 SPA，ui/ 目录）声明。
export const observabilityCapability = defineCapability({
  name: 'observability',
  description:
    'AI 可观测性：runs 列表/时间线、cost 汇总、failure 聚类、subject registry ' +
    '只读视图、今日成本条（cost_ledger + tool_call_log）。',
  api: {
    routes: [
      {
        method: 'GET',
        path: '/api/admin/runs',
        load: () => import('./api/admin-runs').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/admin/runs/[id]',
        load: () => import('./api/admin-run-detail').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/admin/cost',
        load: () => import('./api/admin-cost').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/admin/failures',
        load: () => import('./api/admin-failures').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/admin/subjects',
        load: () => import('./api/admin-subjects').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/cost/today',
        load: () => import('./api/cost-today').then((m) => m.GET),
      },
      // YUK-348 (B1) — per-KC mastery-calibration firm-up 只读观测面。读模型
      // server/calibration-maturity.ts（纯 drizzle，零写路径）。/api/* token 校验
      // 由组合根中间件统一施加。
      {
        method: 'GET',
        path: '/api/observability/calibration-maturity',
        load: () => import('./api/calibration-maturity').then((m) => m.GET),
      },
      // YUK-519 (A7 成效趋势面) — per-KC / per-subject 纵向成效趋势只读观测面。读模型
      // server/effectiveness-trend.ts（纯 drizzle，零写路径）。横截面诊断看 calibration-
      // maturity；本面看纵向 delta（涨/保持/退 + 置信）。/api/* token 校验由组合根中间件统一施加。
      {
        method: 'GET',
        path: '/api/observability/effectiveness-trend',
        load: () => import('./api/effectiveness-trend').then((m) => m.GET),
      },
      // M5-T5a (YUK-321) — 内核运维面收编：备份恢复（spec keep 行，路径沿旧
      // /api/_/{export,import}）+ 统一事件流撤回面（correction 内核不变量，
      // 原 app/api/events/[id]/correct）。裸查/rate 面退役见 Task 9。
      {
        method: 'GET',
        path: '/api/_/export',
        load: () => import('./api/backup-export').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/_/import',
        load: () => import('./api/backup-import').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/events/[id]/correct',
        load: () => import('./api/event-correct').then((m) => m.POST),
      },
      // YUK-310 — 通用异步 job tracker：caller-agnostic SSE。把 ingestion 的
      // per-domain /api/ingestion/[id]/events 提升为 /api/jobs/[kind]/[id]/events，
      // kind→business_table、id→business_id；copilot_run 是首个消费者。job_events
      // 表本就泛型，无 schema 变更。ingestion 路由作为共存别名保留。UI run-card
      // 绑定 = Phase-3 follow-up。
      {
        method: 'GET',
        path: '/api/jobs/[kind]/[id]/events',
        load: () => import('./api/job-events').then((m) => m.GET),
      },
    ],
  },
  // M5-T4b (YUK-321)：admin 四页迁 SPA（ui/observability.tsx + ui/subjects.tsx）。
  // admin 是独立壳形态（design app.jsx:106-114），不挂主 app chrome。
  ui: {
    pages: [
      { route: '/admin/runs' },
      { route: '/admin/cost' },
      { route: '/admin/failures' },
      { route: '/admin/subjects' },
    ],
  },
});
