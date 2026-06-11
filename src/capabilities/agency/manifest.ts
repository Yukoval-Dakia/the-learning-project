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
  // M4-T4 (YUK-319)：proposal kind 归属声明。learning_item / completion /
  // relearn 的 accept applier 真身在 ./server/proposal-appliers；goal_scope
  // 的在 ./server/goals/accept（YUK-143，早于 T4 已是包内委托形态）；defer 有
  // producer 但无 accept applier——accept 走 dispatch 壳 default throw
  // （unsupported_proposal_kind，YUK-44 收口），归属声明与 applier 存在性解耦。
  proposals: {
    kinds: [
      { kind: 'learning_item' },
      { kind: 'completion' },
      { kind: 'relearn' },
      { kind: 'goal_scope' },
      { kind: 'defer' },
    ],
  },
  ui: { pages: [{ route: '/agent-notes' }], todayBlocks: ['agent-notes-board'] },
});
