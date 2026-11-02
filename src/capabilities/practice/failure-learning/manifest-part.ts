// 错因学习 owner 的 manifest 片段，由根 `manifest.ts` 组合。
import type { CapabilityManifest } from '@/kernel/manifest';

export const failureLearningManifestPart: Omit<CapabilityManifest, 'name' | 'description'> = {
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
          import('../server/failure-learning-subscription').then(
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
          import('../jobs/attribution_followup').then((m) => m.buildAttributionFollowupHandler),
      },
      {
        // Durable stage 2: propose-only cause-targeted variant generation.
        name: 'variant_gen',
        queue: 'llm',
        load: () => import('../jobs/variant_gen').then((m) => m.buildVariantGenHandler),
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
            import('../server/proposal-accept-applier').then(
              (module) => module.causeCategoryProposalAcceptApplier,
            ),
        },
        retract: {
          load: () =>
            import('../server/proposal-accept-applier').then(
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
        load: () =>
          import('../server/tools/get-attempt-context').then((m) => m.getAttemptContextTool),
      },
      {
        name: 'query_mistakes',
        load: () => import('../server/tools/query-mistakes').then((m) => m.queryMistakesTool),
      },
      {
        name: 'attribute_mistake',
        load: () => import('../tools/attribute-mistake').then((m) => m.attributeMistakeTool),
      },
      {
        name: 'propose_variant',
        load: () => import('../tools/propose-variant').then((m) => m.proposeVariantTool),
      },
    ],
  },
};
