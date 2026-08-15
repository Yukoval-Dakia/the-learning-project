import type { Tx } from '@/db/client';
import { knowledge } from '@/db/schema';

export interface CreateLearningIntentKnowledgeNodeInput {
  id: string;
  name: string;
  domain: string | null;
  parentId: string | null;
  createdAt: Date;
}

export type CreateLearningIntentKnowledgeNodeFn = (
  tx: Tx,
  input: CreateLearningIntentKnowledgeNodeInput,
) => Promise<void>;

export const createLearningIntentKnowledgeNode: CreateLearningIntentKnowledgeNodeFn = async (
  tx,
  input,
) => {
  await tx.insert(knowledge).values({
    id: input.id,
    name: input.name,
    domain: input.domain,
    parent_id: input.parentId,
    merged_from: [],
    proposed_by_ai: true,
    approval_status: 'approved',
    created_at: input.createdAt,
    updated_at: input.createdAt,
    version: 0,
  });
};
