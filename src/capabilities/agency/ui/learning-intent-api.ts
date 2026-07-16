import { apiJson } from '@/ui/lib/api';

export interface LearningIntentPlanNode {
  title: string;
  one_line_intent: string;
}

export interface LearningIntentProposalWire {
  proposal_id: string;
  topic: string;
  plan_case: '3a_topic_missing' | '3b_children_missing' | '3c_existing_graph';
  hub: { title: string; summary_md: string };
  atomics: LearningIntentPlanNode[];
  longs: LearningIntentPlanNode[];
}

export function createLearningIntentProposal(topic: string): Promise<LearningIntentProposalWire> {
  return apiJson<LearningIntentProposalWire>('/api/learning-intents', {
    method: 'POST',
    body: JSON.stringify({ topic }),
  });
}
