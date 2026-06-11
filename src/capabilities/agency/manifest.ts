import { defineCapability } from '@/kernel/manifest';

export const agencyCapability = defineCapability({
  name: 'agency',
  description:
    '能动编排：夜间链路（dreaming / coach / maintenance 路径维护）+ goal scope 提议 + ' +
    'AI 内部协调信道 agent-notes（hints not facts，用户侧只读观察窗）。',
  events: { actions: ['experimental:agent_note'] },
  api: {
    routes: [
      {
        method: 'GET',
        path: '/api/agents/notes',
        // M0 (YUK-313)：懒加载 thunk——manifest 保持纯元数据（unit 分区不拉 db），
        // server 组合根挂载时才解析 handler。
        load: () => import('./api/notes').then((m) => m.GET),
      },
    ],
  },
  jobs: {
    // M4 (YUK-319) 夜链四 job 入容器。cron 全部 Asia/Shanghai；pg-boss cron 调度
    // 本身是 singleton 语义（同名队列同 cron 只触发一次），档位映射建队配方见
    // kernel JobDecl docblock。注册由 server/boss/register-capability-jobs.ts
    // 收集挂载（T3），此处声明是唯一归属源。
    handlers: [
      {
        name: 'dreaming_nightly',
        schedule: { cron: '15 3 * * *', tz: 'Asia/Shanghai' },
        queue: 'agent',
        load: () => import('./jobs/dreaming_nightly').then((m) => m.buildDreamingNightlyHandler),
      },
      {
        name: 'coach_daily',
        schedule: { cron: '45 3 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () => import('./jobs/coach_daily').then((m) => m.buildCoachDailyHandler),
      },
      {
        name: 'coach_weekly',
        schedule: { cron: '30 4 * * 0', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () => import('./jobs/coach_weekly').then((m) => m.buildCoachWeeklyHandler),
      },
      {
        name: 'goal_scope_propose_nightly',
        schedule: { cron: '50 3 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/goal_scope_propose_nightly').then(
            (m) => m.buildGoalScopeProposeNightlyHandler,
          ),
      },
    ],
  },
  // proposals.kinds 归属声明在 T4（提议生命周期契约真身）补齐——learning_item /
  // completion / relearn / defer / goal_scope，见 plan Task 4。
  ui: { pages: [{ route: '/agent-notes' }], todayBlocks: ['agent-notes-board'] },
});
