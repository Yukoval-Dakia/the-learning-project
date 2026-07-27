import { type ApiOperationJsonResponse, apiOperationJson } from '@/ui/lib/api';

export type LearningIntentProposalWire = ApiOperationJsonResponse<'createLearningIntentProposal'>;
export type LearningIntentPlanNode = LearningIntentProposalWire['atomics'][number];

export function createLearningIntentProposal(topic: string): Promise<LearningIntentProposalWire> {
  return apiOperationJson('createLearningIntentProposal', {
    url: '/api/learning-intents',
    method: 'POST',
    body: { topic },
  });
}
