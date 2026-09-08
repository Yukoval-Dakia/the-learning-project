import { eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { projectKnowledgeNodeGuarded } from '@/server/projections/knowledge';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';

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
  // Preserve create-only semantics: projection upserts must not silently replace an existing node.
  await acquireSortedAdvisoryLocks(tx, 'knowledge:create', [input.id]);
  const [existing] = await tx
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(eq(knowledge.id, input.id));
  if (existing) throw new Error(`knowledge ${input.id} already exists`);
  const row = {
    id: input.id,
    name: input.name,
    domain: input.domain,
    parent_id: input.parentId,
    merged_from: [],
    archived_at: null,
    proposed_by_ai: true,
    approval_status: 'approved' as const,
    created_at: input.createdAt,
    updated_at: input.createdAt,
    version: 0,
  };
  const genesisId = newId();
  await writeEvent(tx, {
    id: genesisId,
    actor_kind: 'system',
    actor_ref: 'learning-intent-accept',
    action: 'experimental:genesis',
    subject_kind: 'knowledge',
    subject_id: input.id,
    outcome: 'success',
    payload: { row },
    caused_by_event_id: input.causedByEventId,
    created_at: input.createdAt,
    ingest_at: input.createdAt,
  });
  await upsertMaterializedIdIndex(tx, {
    materialized_id: input.id,
    anchor_event_id: genesisId,
    subject_kind: 'knowledge',
  });
  await projectKnowledgeNodeGuarded(tx, input.id);
};
