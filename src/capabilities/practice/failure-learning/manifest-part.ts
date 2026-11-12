// 错因学习 owner 的 manifest 片段，由根 `manifest.ts` 组合。
import { API_ERROR_RESPONSES } from '@/kernel/http-contracts';
import type { CapabilityManifest } from '@/kernel/manifest';
import {
  AttemptCauseOptionsResponseSchema,
  AttemptCauseParamsSchema,
  SetAttemptCauseBodySchema,
  SetAttemptCauseResponseSchema,
} from './api/contracts';

export const failureLearningManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
  api: {
    routes: [
      {
        method: 'POST',
        path: '/api/practice/attempts/[attemptEventId]/cause',
        operationId: 'setAttemptCause',
        request: {
          params: AttemptCauseParamsSchema,
          body: SetAttemptCauseBodySchema,
        },
        responses: {
          200: SetAttemptCauseResponseSchema,
          ...API_ERROR_RESPONSES,
        },
        successStatus: 200,
        load: () => import('./api/attempt-cause').then((m) => m.POST),
      },
      {
        method: 'GET',
        path: '/api/practice/attempts/[attemptEventId]/cause-options',
        operationId: 'getAttemptCauseOptions',
        request: { params: AttemptCauseParamsSchema },
        responses: { 200: AttemptCauseOptionsResponseSchema, ...API_ERROR_RESPONSES },
        successStatus: 200,
        pagination: 'none',
        load: () => import('./api/attempt-cause').then((m) => m.GET),
      },
    ],
  },
  subscriptions: {
    handlers: [
      {
        id: 'practice.failure-learning-attempt',
        version: 3,
        actions: [
          'attempt',
          'experimental:assessment_attempt',
          'experimental:assessment_activation',
          'experimental:assessment_feedback_released',
        ],
        load: () =>
          import('./server/failure-learning-subscription').then(
            (m) => m.buildFailureLearningAttemptSubscriber,
          ),
      },
    ],
  },
  jobs: {
    handlers: [
      {
        // Durable stage 1: classify an active question failure, write the exact
        // causal judge, then hand off stage 2 with a stable per-attempt job id.
        name: 'attribution_followup',
        queue: 'llm',
        load: () =>
          import('./jobs/attribution_followup').then((m) => m.buildAttributionFollowupHandler),
      },
      {
        // Durable stage 2: propose-only cause-targeted variant generation.
        name: 'variant_gen',
        queue: 'llm',
        load: () => import('./jobs/variant_gen').then((m) => m.buildVariantGenHandler),
      },
      {
        // Single recovery owner for dispatch intents whose engine-acceptance
        // event never landed (engine down at delivery, crash between the
        // business commit and the send, or a lost subscription wake).
        name: 'failure_learning_dispatch',
        queue: 'fast',
        schedule: { cron: '*/5 * * * *', tz: 'Asia/Shanghai' },
        load: () =>
          import('./server/failure-learning-dispatch').then(
            (m) => m.buildFailureLearningDispatchHandler,
          ),
      },
    ],
  },
  proposals: {
    kinds: [
      // YUK-1016 / 454-B — 错因 catalog 扩张：accept INSERT overlay 行、retract
      // 置 archived_at。dismiss 无定制语义（pending 期尚无行可立），走 generic
      // rate-event 路径。
      {
        kind: 'cause_category',
        accept: {
          load: () =>
            import('./server/cause-category-appliers').then(
              (module) => module.causeCategoryProposalAcceptApplier,
            ),
        },
        retract: {
          load: () =>
            import('./server/cause-category-appliers').then(
              (module) => module.causeCategoryProposalRetractApplier,
            ),
        },
      },
    ],
  },
  copilotTools: {
    tools: [
      {
        name: 'get_attempt_context',
        load: () => import('./tools/get-attempt-context').then((m) => m.getAttemptContextTool),
      },
      {
        name: 'query_mistakes',
        load: () => import('./tools/query-mistakes').then((m) => m.queryMistakesTool),
      },
      {
        name: 'attribute_mistake',
        load: () => import('./tools/attribute-mistake').then((m) => m.attributeMistakeTool),
      },
      {
        name: 'propose_variant',
        load: () => import('./tools/propose-variant').then((m) => m.proposeVariantTool),
      },
    ],
  },
};
