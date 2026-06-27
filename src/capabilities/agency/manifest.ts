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
      {
        // 冷启 P0 (YUK-472)：at-entry 直写 goal（source='manual'），与 ADR-0025
        // proposal-materialize 路径并存（同走 insertGoal 单写面）。给 placement 探针供 scope。
        method: 'POST',
        path: '/api/goals',
        load: () => import('./api/goal-create').then((m) => m.POST),
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
      // YUK-406 Phase 0 (关系脑) / YUK-440 (A13) — nightly 教研例会 conjecture
      // proposer. Single proposer of `conjecture` proposals: deterministic 取证 →
      // Opus N=3 self-consistency induction → propose ≤3. queue:'llm' (it runs the
      // anthropic-sub OAuth Opus lane). Staggered after goal_scope (03:50).
      {
        name: 'research_meeting_nightly',
        schedule: { cron: '35 4 * * *', tz: 'Asia/Shanghai' },
        queue: 'llm',
        load: () =>
          import('./jobs/research_meeting_nightly').then(
            (m) => m.buildResearchMeetingNightlyHandler,
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
      // YUK-406 Phase 0 / YUK-440 A13 — conjecture (subject_kind 'mind_model').
      // Propose-only in this MVP: no accept applier (备课台 accept/edit/reject lane
      // is design-gated), so accept goes through the dispatch shell's default throw
      // (unsupported_proposal_kind) — ownership declared, applier deferred, exactly
      // like `defer`.
      { kind: 'conjecture' },
    ],
  },
  ui: { pages: [{ route: '/agent-notes' }], todayBlocks: ['agent-notes-board'] },
  // M5-T3 (YUK-321) — copilot 工具归属声明（learning_item 上下文读 1 + 生命周期提议 4）。
  copilotTools: {
    tools: [
      {
        name: 'get_learning_item_context',
        load: () =>
          import('@/server/ai/tools/context-readers').then((m) => m.getLearningItemContextTool),
      },
      {
        name: 'propose_learning_item_completion',
        load: () =>
          import('@/server/ai/tools/proposal-tools').then(
            (m) => m.proposeLearningItemCompletionTool,
          ),
      },
      {
        name: 'propose_learning_item_relearn',
        load: () =>
          import('@/server/ai/tools/proposal-tools').then((m) => m.proposeLearningItemRelearnTool),
      },
      {
        name: 'propose_learning_item_defer',
        load: () =>
          import('@/server/ai/tools/proposal-tools').then((m) => m.proposeLearningItemDeferTool),
      },
      {
        name: 'propose_learning_item_archive',
        load: () =>
          import('@/server/ai/tools/proposal-tools').then((m) => m.proposeLearningItemArchiveTool),
      },
    ],
  },
});
