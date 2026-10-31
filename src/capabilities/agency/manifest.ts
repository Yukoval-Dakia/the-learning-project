import { PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import {
  INTERVENTION_ACTIVATED_ACTION,
  INTERVENTION_PREPARATION_FAILED_ACTION,
  INTERVENTION_SETTLED_ACTION,
} from '@/core/schema/intervention';
import { API_ERROR_RESPONSES, ApiIdParamsSchema } from '@/kernel/http-contracts';
import { defineCapability } from '@/kernel/manifest';
import { nightlyEligibility } from '@/kernel/nightly-eligibility';
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
        id: 'agency.probe-publication-serve',
        version: 1,
        actions: ['experimental:assessment_publish'],
        load: () =>
          import('./server/conjecture/probe-lifecycle').then(
            (m) => m.buildProbePublicationSubscriber,
          ),
      },
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
        // Trusted canonical judge events advance the Agency-owned settlement aggregate;
        // rejudge events recompute the same diagnostic.
        id: 'agency.intervention-diagnostic-review-settlement',
        version: 4,
        actions: ['judge', 'experimental:assessment_activation', 'correct'],
        load: () =>
          import('./server/intervention/settlement-subscription').then(
            (m) => m.buildInterventionDiagnosticJudgeSubscriber,
          ),
      },
      {
        // Practice commits the verification; Agency owns the coach hint. Delivery
        // is after commit, so a note failure cannot retry the verify job.
        id: 'agency.question-pool-gap',
        version: 1,
        actions: ['experimental:quiz_verify'],
        load: () =>
          import('./server/question-pool-gap-subscription').then(
            (m) => m.buildQuestionPoolGapSubscriber,
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
        // 懒加载 thunk——manifest 保持纯元数据（unit 分区不拉 db），server 组合根
        // 挂载时才解析 handler。
        load: () => import('./api/notes').then((m) => m.GET),
      },
      {
        // Creates a learning_item proposal only. Acceptance stays on the canonical
        // /api/proposals/[id]/decisions route, not a bespoke accept shell.
        method: 'POST',
        path: '/api/learning-intents',
        operationId: 'createLearningIntentProposal',
        request: { body: CreateLearningIntentBodySchema },
        responses: { 200: LearningIntentProposalResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        load: () => import('./api/learning-intent-create').then((m) => m.POST),
      },
      {
        // at-entry 直写 goal（source='manual'），与 ADR-0025 proposal-materialize 路径
        // 并存（同走 insertGoal 单写面）。给 placement 探针供 scope。
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
        // Probe answer route, isolated from the attempt/FSRS write path: the judge runs
        // PURE, then answerProbe writes exactly ONE experimental:probe_result event and,
        // for preliminary evidence, atomically serves the pre-authored follow-up question.
        // Grading is separate from the recurrence-gated conjecture resolution.
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
    // cron 全部 Asia/Shanghai；pg-boss cron 调度本身是 singleton 语义（同名队列同 cron
    // 只触发一次），档位映射建队配方见 kernel JobDecl docblock。注册由
    // server/boss/register-capability-jobs.ts 收集挂载，此处声明是唯一归属源。
    handlers: [
      {
        // DAG 成员：dreaming 读 proposal inbox 作去重基线，对上游 propose 生产者是软边
        // （上游失败 dreaming 照跑，只是少看几条 pending）。cron 移除，改由 orchestrator 触发。
        name: 'dreaming_nightly',
        eligibility: nightlyEligibility('reflection'),
        dependsOn: [
          { job: 'knowledge_edge_propose_nightly', soft: true },
          { job: 'knowledge_maintenance_nightly', soft: true },
        ],
        queue: 'agent',
        load: () => import('./jobs/dreaming_nightly').then((m) => m.buildDreamingNightlyHandler),
      },
      {
        // DAG 成员（根）：coach_daily 读在线 mastery/session 态，无 in-scope 夜链上游。
        // cron 移除，orchestrator 起步即触发。
        name: 'coach_daily',
        dependsOn: [],
        eligibility: nightlyEligibility('reflection'),
        queue: 'llm',
        load: () => import('./jobs/coach_daily').then((m) => m.buildCoachDailyHandler),
      },
      {
        name: 'coach_weekly',
        schedule: { cron: '30 4 * * 0', tz: 'Asia/Shanghai' },
        eligibility: nightlyEligibility('reflection'),
        queue: 'llm',
        load: () => import('./jobs/coach_weekly').then((m) => m.buildCoachWeeklyHandler),
      },
      {
        // On-demand, intervention-scoped preparation wave. One recommendation is
        // immediately consumed by QuestionAuthor, then a separate same-model review gates
        // atomic activation. No cron and no ordinary KC fallback.
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
        // DAG 成员（根）：propose-only 生产者，读 tree/goals 产 goal_scope 提议入人审 inbox，
        // 不消费其它夜链 job 的 live 产物。cron 移除。
        name: 'goal_scope_propose_nightly',
        dependsOn: [],
        eligibility: nightlyEligibility('reflection'),
        queue: 'llm',
        load: () =>
          import('./jobs/goal_scope_propose_nightly').then(
            (m) => m.buildGoalScopeProposeNightlyHandler,
          ),
      },
      // Nightly 教研例会 conjecture proposer — the single proposer of `conjecture`
      // proposals: deterministic evidence gathering → Opus N=3 self-consistency induction
      // → at most 3 proposals. queue:'llm' (runs the anthropic-sub OAuth Opus lane).
      // DAG 成员（根）：propose-only，读取证据自 induce，不消费其它夜链 job 的 live 产物。
      // cron 移除，orchestrator 触发。
      {
        name: 'research_meeting_nightly',
        dependsOn: [],
        eligibility: nightlyEligibility('reflection'),
        queue: 'llm',
        load: () =>
          import('./jobs/research_meeting_nightly').then(
            (m) => m.buildResearchMeetingNightlyHandler,
          ),
      },
      // Agent-led 教研例会 director (shadow lane, dark-ship). The app-level pending-dedup
      // TOCTOU must stay closed: the deterministic lane commits its proposals before the
      // agent lane reads the pending inbox as its dedup base. That is a DAG hard edge, not
      // a clock offset. queue:'agent' because ResearchMeetingDirectorTask is a multi-turn
      // tool loop (EXPIRE_AGENT=7200s exceeds its own 300s wall-clock abort). Kill switch
      // RESEARCH_MEETING_AGENT_ENABLED (default OFF) makes the handler a no-op while the
      // node still succeeds.
      {
        name: 'research_meeting_agent_nightly',
        dependsOn: ['research_meeting_nightly'],
        eligibility: nightlyEligibility('reflection'),
        queue: 'agent',
        load: () =>
          import('./jobs/research_meeting_agent_nightly').then(
            (m) => m.buildResearchMeetingAgentNightlyHandler,
          ),
      },
    ],
  },
  // proposal kind 归属声明。learning_item / completion / relearn 的 accept applier 真身在
  // ./server/proposal-appliers；goal_scope 的在 ./server/goals/accept；defer 有 producer 但
  // 无 accept applier——accept 走 dispatch 壳 default throw（unsupported_proposal_kind）。
  // 归属声明与 applier 存在性解耦。
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
      // conjecture (subject_kind 'mind_model'). The accept applier lives in
      // ./server/conjecture-accept (accept = calibration anchor / edit → mem0 CORE /
      // reject → digest, never FSRS). This package owns both proposer and applier.
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
  // copilot 工具归属声明（learning_item 上下文读 1 + 生命周期提议 4）。
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
