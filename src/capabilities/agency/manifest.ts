import { PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import {
  INTERVENTION_ACTIVATED_ACTION,
  INTERVENTION_PREPARATION_FAILED_ACTION,
  INTERVENTION_SETTLED_ACTION,
} from '@/core/schema/intervention';
import { API_ERROR_RESPONSES, ApiIdParamsSchema } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';
import {
  AgentNotesQuerySchema,
  AgentNotesResponseSchema,
  CreateLearningIntentBodySchema,
  LearningIntentProposalResponseSchema,
  ProbeAnswerBodySchema,
  ProbeAnswerParamsSchema,
  ProbeAnswerResponseSchema,
} from './api/contracts';
import { CreateGoalBody, GoalSchema } from './api/goal-contracts';

export const agencyCapability = defineCapability({
  name: 'agency',
  description:
    '能动编排：夜间链路（dreaming / coach / maintenance 路径维护）+ goal scope 提议 + ' +
    'AI 内部协调信道 agent-notes（hints not facts，用户侧只读观察窗）。',
  events: {
    actions: [
      'experimental:agent_note',
      PROBE_RESULT_ACTION,
      INTERVENTION_ACTIVATED_ACTION,
      INTERVENTION_PREPARATION_FAILED_ACTION,
      INTERVENTION_SETTLED_ACTION,
    ],
  },
  subscriptions: {
    handlers: [
      {
        id: 'agency.probe-evidence-intervention-prepare',
        version: 1,
        actions: [PROBE_RESULT_ACTION],
        load: () =>
          import('./server/intervention/probe-result-subscription').then(
            (m) => m.buildProbeResultInterventionSubscriber,
          ),
      },
      {
        // YUK-792 — trusted canonical judge events advance the Agency-owned
        // settlement aggregate. Rejudge events recompute the same diagnostic.
        id: 'agency.intervention-diagnostic-review-settlement',
        version: 2,
        actions: ['judge'],
        load: () =>
          import('./server/intervention/settlement-subscription').then(
            (m) => m.buildInterventionDiagnosticJudgeSubscriber,
          ),
      },
    ],
  },
  api: {
    routes: [
      {
        method: 'GET',
        path: '/api/agents/notes',
        operationId: 'listAgentNotes',
        request: { query: AgentNotesQuerySchema },
        responses: { 200: AgentNotesResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        // M0 (YUK-313)：懒加载 thunk——manifest 保持纯元数据（unit 分区不拉 db），
        // server 组合根挂载时才解析 handler。
        load: () => import('./api/notes').then((m) => m.GET),
      },
      {
        // YUK-604 — M5 teardown removed the only live caller of planLearningIntent.
        // Restore the command in the owning capability; acceptance stays on the
        // canonical /api/proposals/[id]/decisions route rather than reviving the
        // bespoke legacy /learning-intents/[id]/accept shell.
        method: 'POST',
        path: '/api/learning-intents',
        operationId: 'createLearningIntentProposal',
        request: { body: CreateLearningIntentBodySchema },
        responses: { 200: LearningIntentProposalResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/learning-intent-create').then((m) => m.POST),
      },
      {
        // 冷启 P0 (YUK-472)：at-entry 直写 goal（source='manual'），与 ADR-0025
        // proposal-materialize 路径并存（同走 insertGoal 单写面）。给 placement 探针供 scope。
        method: 'POST',
        path: '/api/goals',
        operationId: 'createGoal',
        request: { body: CreateGoalBody },
        responses: { 201: GoalSchema, ...API_ERROR_RESPONSES },
        successStatus: 201,
        load: () => import('./api/goal-create').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/goals/[id]',
        operationId: 'getGoal',
        request: { params: ApiIdParamsSchema },
        responses: { 200: GoalSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/goal-create').then((m) => m.GET),
      },
      {
        // conjecture-wire #13 (YUK-538 ⑬ / spec §6 S3) — probe answer route.
        // Isolated from the attempt/FSRS write path: judge routes via
        // defaultJudgeKindForQuestion → capability registry resolveJudge →
        // runner.run() PURE, then answerProbe writes exactly ONE
        // experimental:probe_result event and, for preliminary evidence, atomically
        // serves the pre-authored follow-up question (ND-5). Grading is separate
        // from the recurrence-gated conjecture resolution (YUK-787).
        method: 'POST',
        path: '/api/conjecture/probe/[id]/answer',
        operationId: 'answerConjectureProbe',
        request: { params: ProbeAnswerParamsSchema, body: ProbeAnswerBodySchema },
        responses: { 200: ProbeAnswerResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/probe-answer').then((m) => m.POST),
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
        // YUK-758 DAG 成员：dreaming 读 proposal inbox 作去重基线。对上游 propose 生产者
        // 是**软边**（上游失败 dreaming 照跑——它只是少看几条 pending，仍正确产出；handler
        // 本身不知道也不需要知道上游失败了，YUK-778 已删掉那条无人读的 stale payload）。
        // 编码上游 = 现钟表序下 dreaming(旧 03:15) 实际能看到的两只 producer（edge_propose 02:30
        // / maintenance 03:00）；其余 producer 旧序在 dreaming 之后，非其上游。cron 移除，改由
        // orchestrator 触发。
        name: 'dreaming_nightly',
        dependsOn: [
          { job: 'knowledge_edge_propose_nightly', soft: true },
          { job: 'knowledge_maintenance_nightly', soft: true },
        ],
        queue: 'agent',
        load: () => import('./jobs/dreaming_nightly').then((m) => m.buildDreamingNightlyHandler),
      },
      {
        // YUK-758 DAG 成员（根）：coach_daily 读在线 mastery/session 态，无 in-scope 夜链上游
        // （旧 03:45 错峰是时钟巧合）。cron 移除，orchestrator 起步即触发。
        name: 'coach_daily',
        dependsOn: [],
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
        // YUK-791 — on-demand, intervention-scoped preparation wave. One
        // recommendation is immediately consumed by QuestionAuthor, then a
        // separate same-model review gates atomic activation. No cron and no
        // ordinary KC fallback.
        name: 'prepare_intervention',
        queue: 'llm',
        load: () =>
          import('./jobs/prepare_intervention').then((m) => m.buildPrepareInterventionHandler),
      },
      {
        // Restored `preparing` aggregates are durable business state, while
        // pg-boss rows are operational and are not in the archive. Reconcile
        // within two minutes and replace missing/terminal job ids transactionally.
        name: 'intervention_prepare_recovery',
        schedule: { cron: '1-59/2 * * * *', tz: 'Asia/Shanghai' },
        queue: 'fast',
        load: () =>
          import('./server/intervention/reconcile').then(
            (m) => m.buildInterventionPrepareRecoveryHandler,
          ),
      },
      {
        // YUK-758 DAG 成员（根）：propose-only 生产者，读 tree/goals 产 goal_scope 提议入人审
        // inbox，不消费其它夜链 job 的 live 产物（旧 03:50 错峰是时钟巧合）。cron 移除。
        name: 'goal_scope_propose_nightly',
        dependsOn: [],
        queue: 'llm',
        load: () =>
          import('./jobs/goal_scope_propose_nightly').then(
            (m) => m.buildGoalScopeProposeNightlyHandler,
          ),
      },
      // YUK-406 Phase 0 (关系脑) / YUK-440 (A13) — nightly 教研例会 conjecture
      // proposer. Single proposer of `conjecture` proposals: deterministic 取证 →
      // Opus N=3 self-consistency induction → propose ≤3. queue:'llm' (it runs the
      // anthropic-sub OAuth Opus lane).
      // YUK-758 DAG 成员（根）：propose-only conjecture 生产者，读取证据自induce，不消费其它夜链
      // job 的 live 产物（旧 04:05 错峰是时钟巧合）。cron 移除，orchestrator 触发。
      {
        name: 'research_meeting_nightly',
        dependsOn: [],
        queue: 'llm',
        load: () =>
          import('./jobs/research_meeting_nightly').then(
            (m) => m.buildResearchMeetingNightlyHandler,
          ),
      },
      // YUK-572 — agent-led 教研例会 director (shadow lane, dark-ship). The two lanes'
      // app-level pending-dedup TOCTOU must stay closed: the deterministic lane has to have
      // committed its proposals before the agent lane reads the pending inbox as its dedup
      // base (§3 hard constraint). That ordering is now a DAG edge, not a clock offset —
      // see the YUK-758 note below. Kill switch RESEARCH_MEETING_AGENT_ENABLED (default OFF)
      // makes the handler a no-op.
      //
      // round-3 review CodeRabbit Major (A4) — queue:'agent', NOT 'llm': unlike the
      // deterministic research_meeting_nightly (a bounded parallel producer batch — no MCP
      // tools, no tool-call loop, just N single-shot induceConjecture calls, correctly
      // classified 'llm' per queue-config.ts's own tier docs: "single ~30-90s LLM call
      // handlers"), ResearchMeetingDirectorTask IS a multi-turn, multi-tool-call agent
      // loop with a nested scout subagent spawn — the EXACT profile queue-config.ts's
      // 'agent' tier describes ("multi-step tool-calling agents that can legitimately
      // run for many minutes"), the SAME classification dreaming_nightly already uses.
      // Confirmed timeout coverage (round-3 A3/A4 cross-check): EXPIRE_AGENT=7200s (2h)
      // comfortably exceeds the director's own 300s wall-clock abort budget — pg-boss's
      // queue-level expiry is a crash-recovery safety net, never the primary backstop
      // (the director's own 300s abort always fires first on a healthy run).
      // YUK-758 DAG 成员：←**hard** research_meeting_nightly（review ToPUI）。原「05:35 固定
      // cron，比确定性会议 04:05 晚 90min」的去重屏障在确定性会议入图后失效（会议现由 orchestrator
      // 调度，llm 队列排队/重试可能推后其完成时刻，固定 05:35 不再保证「会议已提交 proposal」）。
      // 入图后 orchestrator 只在 research_meeting_nightly **成功完成后**才触发本 agent lane——
      // happens-after 硬保证，严格强于原 90min 时间差启发式（agent director 读 inbox 去重时，
      // 确定性 lane 的 proposal 必已落库）。cron 移除；kill switch RESEARCH_MEETING_AGENT_ENABLED
      // 仍在（flag OFF 时 handler no-op，节点照常 succeed）。
      {
        name: 'research_meeting_agent_nightly',
        dependsOn: ['research_meeting_nightly'],
        queue: 'agent',
        load: () =>
          import('./jobs/research_meeting_agent_nightly').then(
            (m) => m.buildResearchMeetingAgentNightlyHandler,
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
      {
        kind: 'learning_item',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.learningItemProposalAcceptApplier,
            ),
        },
        dismiss: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.agencyProposalDismissApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.learningItemProposalRetractApplier,
            ),
        },
      },
      {
        kind: 'completion',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.completionProposalAcceptApplier,
            ),
        },
        dismiss: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.agencyProposalDismissApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.completionProposalRetractApplier,
            ),
        },
      },
      {
        kind: 'relearn',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.relearnProposalAcceptApplier,
            ),
        },
        dismiss: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.agencyProposalDismissApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.relearnProposalRetractApplier,
            ),
        },
      },
      {
        kind: 'goal_scope',
        accept: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.goalScopeProposalAcceptApplier,
            ),
        },
        dismiss: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.agencyProposalDismissApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.goalScopeProposalRetractApplier,
            ),
        },
      },
      {
        kind: 'defer',
        dismiss: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.agencyProposalDismissApplier,
            ),
        },
      },
      // YUK-406 Phase 0 / YUK-440 A13 — conjecture (subject_kind 'mind_model').
      // The accept applier 真身在 ./server/conjecture-accept (acceptConjectureProposal:
      // accept = calibration anchor / edit → mem0 CORE / reject → digest, never FSRS).
      // This package owns both the proposer (nightly 例会 job) and the applier.
      {
        kind: 'conjecture',
        accept: {
          correctedPayload: true,
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.conjectureProposalAcceptApplier,
            ),
        },
        dismiss: {
          load: () =>
            import('./server/proposal-accept-applier').then(
              (module) => module.agencyProposalDismissApplier,
            ),
        },
      },
    ],
  },
  ui: { pages: uiPagesFor('agency') },
  // M5-T3 (YUK-321) — copilot 工具归属声明（learning_item 上下文读 1 + 生命周期提议 4）。
  copilotTools: {
    tools: [
      {
        name: 'get_learning_item_context',
        load: () =>
          import('./server/tools/learning-item-context').then((m) => m.getLearningItemContextTool),
      },
      {
        name: 'propose_learning_item_completion',
        load: () =>
          import('./server/tools/proposal-tools').then((m) => m.proposeLearningItemCompletionTool),
      },
      {
        name: 'propose_learning_item_relearn',
        load: () =>
          import('./server/tools/proposal-tools').then((m) => m.proposeLearningItemRelearnTool),
      },
      {
        name: 'propose_learning_item_defer',
        load: () =>
          import('./server/tools/proposal-tools').then((m) => m.proposeLearningItemDeferTool),
      },
      {
        name: 'propose_learning_item_archive',
        load: () =>
          import('./server/tools/proposal-tools').then((m) => m.proposeLearningItemArchiveTool),
      },
      {
        name: 'read_agent_notes',
        load: () => import('./server/tools/agent-note-tools').then((m) => m.readAgentNotesTool),
      },
      {
        name: 'generate_goal_outline',
        load: () =>
          import('./server/tools/generate-goal-outline').then((m) => m.generateGoalOutlineTool),
      },
      {
        name: 'write_agent_note',
        load: () => import('./server/tools/agent-note-tools').then((m) => m.writeAgentNoteTool),
      },
    ],
  },
});
