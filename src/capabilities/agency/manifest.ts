import { ContextBoardResponse, ContextEditRequest, ContextEditResponse, ContextActionRequest, ChangeResult } from './context/wire';
import { CURATOR_ACTIVITY_ACTIONS } from './context/activity-contract';
import { PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import { DREAMING_NOTE_REFRESH_ACTION } from '@/core/schema/event/dreaming-note-refresh';
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
    '能动编排：夜间链路（dreaming / maintenance 路径维护）+ 回访唤醒的 coach + goal scope 提议 + ' +
    'AI 内部协调信道 agent-notes（hints not facts，用户侧只读观察窗）。',
  events: {
    actions: [
      'experimental:context_change',
      'experimental:context_edit_request',
      'experimental:agent_note',
      DREAMING_NOTE_REFRESH_ACTION,
      PROBE_RESULT_ACTION,
      INTERVENTION_ACTIVATED_ACTION,
      INTERVENTION_PREPARATION_FAILED_ACTION,
      INTERVENTION_SETTLED_ACTION,
      // YUK-1770 — the goal write surface agency's steering machinery emits via
      // kernel/records/goal-commands (genesis seeds, status/scope updates). The
      // steering-changed subscription consumes them; composition requires a
      // declared owner. Genesis is a generic action, but agency is the only
      // subscriber and the only writer-path owner (goal routes/commands).
      'experimental:genesis',
      'experimental:goal_status_update',
      'experimental:goal_scope_update',
    ],
  },
  subscriptions: {
    handlers: [
      { id: 'agency.curator-activity', version: 1, actions: CURATOR_ACTIVITY_ACTIONS,
        load: () => import('./context/activity').then(m => m.buildCuratorActivitySubscriber) },
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
        // YUK-1664 — an answered probe is an open obligation: reconcile the typed
        // ledger at answer time instead of waiting for the paid nightly meeting.
        // The nightly run stays as the catch-up sweep; both callers serialize on
        // the shared conjecture-reconcile advisory lock.
        id: 'agency.probe-result-reconcile',
        version: 1,
        actions: [PROBE_RESULT_ACTION],
        load: () =>
          import('./server/conjecture/reconcile-subscription').then(
            (m) => m.buildProbeResultReconcileSubscriber,
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
      {
        // YUK-1770 — goal 写事件的 steering 订阅：任何 steering 落地/修订/撤销都触发
        // 当日重规划（coach，绕过 24h 回归窗）+ 供给重跑 + 今日练习重组。无并行事件
        // 流：直接消费既有 goal 事件（genesis/status/scope）；非 steering 的 goal 写入
        // 在 handler 里跳过。
        id: 'agency.steering-changed',
        version: 1,
        actions: [
          'experimental:genesis',
          'experimental:goal_status_update',
          'experimental:goal_scope_update',
        ],
        load: () =>
          import('./server/steering-subscription').then((m) => m.buildSteeringChangedSubscriber),
      },
    ],
  },
  api: {
    routes: [
      { method: 'GET', path: '/api/learner-context', operationId: 'getLearnerContext',
        responses: { 200: ContextBoardResponse, ...API_ERROR_RESPONSES }, successStatus: 200,
        load: () => import('./api/context').then(m => m.GET) },
      { method: 'POST', path: '/api/learner-context/edit', operationId: 'editLearnerContext',
        request: { body: ContextEditRequest }, responses: { 200: ContextEditResponse, ...API_ERROR_RESPONSES }, successStatus: 200,
        load: () => import('./api/context').then(m => m.EDIT) },
      { method: 'POST', path: '/api/learner-context/action', operationId: 'actOnLearnerContext',
        request: { body: ContextActionRequest }, responses: { 200: ChangeResult, ...API_ERROR_RESPONSES }, successStatus: 200,
        load: () => import('./api/context').then(m => m.ACTION) },
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
      { name: 'curator_activity', queue: 'agent',
        load: () => import('./context/activity').then(m => m.buildCuratorActivityHandler) },
      {
        // DAG 成员：dreaming 读 proposal inbox 作去重基线，对上游 propose 生产者是软边
        // （上游失败 dreaming 照跑，只是少看几条 pending）。cron 移除，改由 orchestrator 触发。
        name: 'dreaming_nightly',
        eligibility: nightlyEligibility('reflection'),
        dependsOn: [{ job: 'knowledge_maintenance_nightly', soft: true }],
        queue: 'agent',
        load: () => import('./jobs/dreaming_nightly').then((m) => m.buildDreamingNightlyHandler),
      },
      {
        // 不在夜间 DAG：学习者回来且计划过期时由 learner_return_wake 经 kernel 端口按义务入队
        // （每 24h 槽至多一次，见 kernel/coach-wake.ts）。
        // Literal on purpose: the task-census audit attributes jobs by string-literal names.
        name: 'coach_daily',
        queue: 'llm',
        load: () => import('./jobs/coach_daily').then((m) => m.buildCoachDailyHandler),
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
      { name: 'remember_learner', load: () => import('./context/write-tools').then(m => m.rememberLearnerTool) },
      { name: 'curate_context', load: () => import('./context/write-tools').then(m => m.curateContextTool) },
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
      // YUK-1794 B1 — the Context warm-layer read (brief + facts layers), owned
      // by agency/context; granted to copilot/coach/dreaming via allowlists.
      {
        name: 'query_context',
        load: () => import('./context/query-context').then((m) => m.queryContextTool),
      },
      {
        name: 'write_agent_note',
        load: () => import('./server/tools/agent-note-tools').then((m) => m.writeAgentNoteTool),
      },
      {
        // YUK-1770 — learner-said steering 直写工具（record_steering）。
        name: 'record_steering',
        load: () => import('./server/tools/record-steering').then((m) => m.recordSteeringTool),
      },
    ],
  },
});
