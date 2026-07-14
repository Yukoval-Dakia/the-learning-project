import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';

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
      // YUK-600 (v3 §3.6) — thin-create：科目创建唯一入口（五步事务 + 幂等回放 +
      // custom↔builtin 撞名 422；YUK-602 onboarding UI 只调这里不自带写面）。
      {
        method: 'POST',
        path: '/api/admin/subjects',
        load: () => import('./api/admin-subjects-create').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/admin/subjects/[id]',
        load: () => import('./api/admin-subjects').then((m) => m.getSubject),
      },
      // YUK-601 (v3.2 §3.5) — trait 管理读面三端点（编辑器/换绑选择器/rollback UI
      // 的数据源；业务在 src/server/subjects/admin-read.ts）。
      {
        method: 'GET',
        path: '/api/admin/subjects/[id]/traits',
        load: () => import('./api/admin-subject-traits').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/admin/traits',
        load: () => import('./api/admin-traits').then((m) => m.GET),
      },
      {
        method: 'GET',
        path: '/api/admin/traits/[id]/journal',
        load: () => import('./api/admin-trait-journal').then((m) => m.GET),
      },
      // YUK-601 (v3.2 §3.1-§3.4) — trait/控制行写面（全部写事务开头控制面
      // advisory lock；业务在 src/server/subjects/{trait-write,subject-control-write}.ts）。
      {
        method: 'PUT',
        path: '/api/admin/subjects/[id]/traits/[kind]',
        load: () => import('./api/admin-subject-trait-write').then((m) => m.PUT),
      },
      {
        method: 'POST',
        path: '/api/admin/subjects/[id]/traits/[kind]/fork',
        load: () => import('./api/admin-subject-trait-write').then((m) => m.FORK),
      },
      {
        method: 'PUT',
        path: '/api/admin/subjects/[id]/traits/[kind]/binding',
        load: () => import('./api/admin-subject-trait-write').then((m) => m.BINDING),
      },
      {
        method: 'PUT',
        path: '/api/admin/traits/[id]',
        load: () => import('./api/admin-trait-write').then((m) => m.PUT),
      },
      {
        method: 'POST',
        path: '/api/admin/traits/[id]/rollback',
        load: () => import('./api/admin-trait-write').then((m) => m.ROLLBACK),
      },
      {
        method: 'POST',
        path: '/api/admin/traits/[id]/reset-to-seed',
        load: () => import('./api/admin-trait-write').then((m) => m.RESET_TO_SEED),
      },
      {
        method: 'PATCH',
        path: '/api/admin/subjects/[id]',
        load: () => import('./api/admin-subject-control').then((m) => m.PATCH),
      },
      {
        method: 'POST',
        path: '/api/admin/subjects/[id]/retire',
        load: () => import('./api/admin-subject-control').then((m) => m.RETIRE),
      },
      {
        method: 'POST',
        path: '/api/admin/subjects/[id]/restore',
        load: () => import('./api/admin-subject-control').then((m) => m.RESTORE),
      },
      {
        method: 'POST',
        path: '/api/admin/subjects/[id]/reset',
        load: () => import('./api/admin-subject-control').then((m) => m.RESET),
      },
      {
        method: 'POST',
        path: '/api/admin/subjects/[id]/validate',
        load: () => import('./api/admin-subject-control').then((m) => m.VALIDATE),
      },
      {
        // conjecture-wire #13 (YUK-538 ⑬ / spec §6 S4 + §10 A4) — calibration loop
        // admin reader. READ-ONLY: prediction_score LOG events + auto-minted
        // kc_typed_state confused-with-X rows. Honest score render (single-point
        // brier/log_loss/skill_score, NOT «accuracy» nor a window mean).
        method: 'GET',
        path: '/api/admin/conjecture-scores',
        load: () => import('./api/conjecture-scores').then((m) => m.GET),
      },
      {
        // YUK-573 — judge 校准 agreement 观测面（唯一暴露面，无前端 UI）。READ-ONLY：
        // 聚合 experimental:judge_calibration_sample / _run_summary events。honesty
        // rails：MIN_N insufficient_data 门（S4）、same_lane 剔除 headline（MF5）、
        // agreement≠accuracy + same_lane 时效双 note、recent_runs mass-skip 自曝。
        method: 'GET',
        path: '/api/admin/judge-calibration',
        load: () => import('./api/judge-calibration').then((m) => m.GET),
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
        method: 'GET',
        path: '/api/events/[id]',
        load: () => import('./api/event-detail').then((m) => m.GET),
      },
      {
        method: 'POST',
        path: '/api/events/[id]/correct',
        load: () => import('./api/event-correct').then((m) => m.POST),
      },
      {
        method: 'POST',
        path: '/api/events/[id]/corrections',
        load: () => import('./api/event-correct').then((m) => m.createCorrectionResource),
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
      // YUK-579 — 供题治理覆盖细目表（coverage lattice）只读观测面。读模型
      // server/coverage-lattice.ts：assembleScanInput + scanCoverageGaps（纯，复用发现引擎，
      // 零新查询子系统）+ 单条 experimental:question_supply 活动聚合。READ-ONLY 零写零 LLM。
      // /api/* token 校验由组合根中间件统一施加。
      {
        method: 'GET',
        path: '/api/admin/coverage-lattice',
        load: () => import('./api/coverage-lattice').then((m) => m.GET),
      },
    ],
  },
  jobs: {
    handlers: [
      // YUK-601 PR7 (v3.2 §7) — 夜间装配漂移审计（--strict：invalid → job failed
      // 可见）。'25 4' 避撞既有夜链排期；fast 档纯 DB 无 LLM。
      {
        name: 'subject_profile_audit_nightly',
        schedule: { cron: '25 4 * * *', tz: 'Asia/Shanghai' },
        queue: 'fast',
        load: () =>
          import('./jobs/subject_profile_audit_nightly').then(
            (m) => m.buildSubjectProfileAuditNightlyHandler,
          ),
      },
      // YUK-576 §5 — stuck-in-running reconcile sweeper（辅触发；主触发是
      // start-worker.ts 的 boot-time sweep）。fast 档（无 DLQ）：sweep 幂等，
      // 掉一拍下轮 cron 重收敛（queue-config.ts fast 档既定语义）。06:40 取空闲
      // 分钟位（原 06:10 与 #729 judge_calibration_sample_nightly 撞车，
      // composition 唯一性断言拦下）；sweeper 幂等且时间不敏感，任何空位皆可。
      // 1h 阈值意味着本轮收敛 ≤05:40 起卡住的行。
      {
        name: 'ai_task_run_reconcile_nightly',
        schedule: { cron: '40 6 * * *', tz: 'Asia/Shanghai' },
        queue: 'fast',
        load: () =>
          import('@/server/boss/handlers/ai_task_run_reconcile').then(
            (m) => m.buildAiTaskRunReconcileHandler,
          ),
      },
    ],
  },
  // admin 五页 SPA（ui/observability.tsx + ui/subjects.tsx + ui/coverage-lattice.tsx）。
  // 壳形态：admin 页套主 app chrome（RootShell）——见 docs/design/2026-07-07-yuk579-coverage-
  // lattice.md §6 决策记录（loom app.jsx 的「separate shell」原型已被 SPA 单一 RootShell 取代，
  // owner 已收编）。
  ui: { pages: uiPagesFor('observability') },
});
