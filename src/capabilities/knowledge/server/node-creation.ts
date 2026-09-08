import { eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { gatherAndFoldKnowledgeNode } from '@/server/projections/gather';
import { projectKnowledgeNodeGuarded } from '@/server/projections/knowledge';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';

type InitialKnowledge = Pick<
  KnowledgeRowSnapshotT,
  'id' | 'name' | 'domain' | 'parent_id' | 'proposed_by_ai' | 'created_at'
>;

/** Create an approved node from birth history. Existing nodes are never rewritten or backfilled. */
export async function createKnowledgeNodeFromEvents(
  tx: Tx,
  initial: InitialKnowledge,
  provenance: { actorRef: string; eventId?: string; causedByEventId?: string },
  onExisting: 'error' | 'skip' = 'error',
): Promise<boolean> {
  await acquireSortedAdvisoryLocks(tx, 'knowledge:create', [initial.id]);
  const [existing] = await tx
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(eq(knowledge.id, initial.id));
  if (existing) {
    if (onExisting === 'error') throw new Error(`knowledge ${initial.id} already exists`);
    return false;
  }
  if (await gatherAndFoldKnowledgeNode(tx, initial.id)) {
    throw new Error(
      `knowledge ${initial.id} has history without a live row; repair before creation`,
    );
  }
  const row: KnowledgeRowSnapshotT = {
    ...initial,
    merged_from: [],
    archived_at: null,
    approval_status: 'approved',
    updated_at: initial.created_at,
    version: 0,
  };
  const eventId = provenance.eventId ?? newId();
  await writeEvent(tx, {
    id: eventId,
    actor_kind: 'system',
    actor_ref: provenance.actorRef,
    action: 'experimental:genesis',
    subject_kind: 'knowledge',
    subject_id: row.id,
    outcome: 'success',
    payload: { row },
    caused_by_event_id: provenance.causedByEventId,
    created_at: row.created_at,
    ingest_at: row.created_at,
  });
  await upsertMaterializedIdIndex(tx, {
    materialized_id: row.id,
    anchor_event_id: eventId,
    subject_kind: 'knowledge',
  });
  await projectKnowledgeNodeGuarded(tx, row.id);
  return true;
}
