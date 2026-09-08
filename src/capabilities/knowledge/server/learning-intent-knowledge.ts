import type { Tx } from '@/db/client';
import { createKnowledgeNodeFromEvents } from './node-creation';

export interface CreateLearningIntentKnowledgeNodeInput {
  id: string;
  name: string;
  domain: string | null;
  parentId: string | null;
  createdAt: Date;
  causedByEventId: string;
}

export type CreateLearningIntentKnowledgeNodeFn = (
  tx: Tx,
  input: CreateLearningIntentKnowledgeNodeInput,
) => Promise<void>;

export const createLearningIntentKnowledgeNode: CreateLearningIntentKnowledgeNodeFn = async (
  tx,
  input,
) => {
  await createKnowledgeNodeFromEvents(
    tx,
    {
      id: input.id,
      name: input.name,
      domain: input.domain,
      parent_id: input.parentId,
      proposed_by_ai: true,
      created_at: input.createdAt,
    },
    { actorRef: 'learning-intent-accept', causedByEventId: input.causedByEventId },
  );
};
