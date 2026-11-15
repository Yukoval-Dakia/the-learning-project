import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type CreateLearningIntentWire = ApiOperationJsonResponse<'createLearningIntentProposal'>;
export type LearningIntentProposalWire = Extract<
  CreateLearningIntentWire,
  { kind: 'learning_item' }
>;
export type LearningIntentPlanNode = LearningIntentProposalWire['atomics'][number];

/** YUK-2124 — narrow the generated create response between its two lanes. */
export type GoalScopeIntentWire = Extract<CreateLearningIntentWire, { kind: 'goal_scope' }>;

export function isGoalScopeIntentWire(wire: CreateLearningIntentWire): wire is GoalScopeIntentWire {
  return wire.kind === 'goal_scope';
}

export function createLearningIntentProposal(topic: string): Promise<CreateLearningIntentWire> {
  return apiOperationJson('createLearningIntentProposal', {
    url: '/api/learning-intents',
    method: 'POST',
    body: { topic },
  });
}
