import type { Tx } from '@/db/client';
import { createKnowledgeNodeFromEvents } from './node-creation';

export interface CreateLearningIntentKnowledgeNodeInput {
  id: string;
  name: string;
  domain: string | null;
  parentId: string | null;
  createdAt: Date;
  causedByEventId: string;
  /**
   * YUK-1600 — the 3a topic root is a learning GOAL, not a testable KC: it must never
   * carry θ/PFA/FSRS readings or enter supply/selection candidates. Absent (the
   * proposed children) means the default 'kc'.
   */
  role?: 'goal' | 'container';
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
      role: input.role,
      created_at: input.createdAt,
    },
    { actorRef: 'learning-intent-accept', causedByEventId: input.causedByEventId },
  );
};
