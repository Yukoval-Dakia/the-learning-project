import { eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { KnowledgeRowSnapshotT } from '@/core/schema/event/genesis';
import type { Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { gatherAndFoldKnowledgeNode } from '@/kernel/records/knowledge-node-history';
import { projectKnowledgeNodeGuarded } from '@/kernel/records/knowledge-node-materialization';
import { upsertMaterializedIdIndex } from '@/kernel/records/materialized-id-index';
import { acquireSortedAdvisoryLocks } from '@/server/advisory-locks';
import { requireKnowledgeHistory } from '@/server/projections/knowledge';
import { resolveKnownSubjectId } from '@/subjects/profile';

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
  // `general` is the fallback identity, never a node domain. Aliases canonicalize;
  // unknown domains pass through.
  const canonicalDomain = resolveKnownSubjectId(initial.domain);
  if (canonicalDomain === 'general') {
    throw new Error(
      `knowledge ${initial.id} rejected: 'general' is the fallback subject identity, not a node domain`,
    );
  }
  // Callers own authorization: this seam creates approved nodes. Agent-invented
  // KCs go through tagKnowledge, which declares pending. A future ad-hoc caller
  // must carry explicit authorization rather than self-approving.
  const row: KnowledgeRowSnapshotT = {
    ...initial,
    domain: canonicalDomain ?? initial.domain,
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

export function subjectRootId(subjectId: string): string {
  return `seed:${subjectId}:root`;
}

/** Idempotent subject root birth. Existing roots are never rewritten or given replacement history. */
export async function ensureSubjectRoot(
  tx: Tx,
  subjectId: string,
  displayName: string,
): Promise<{ created: boolean; rootId: string }> {
  const rootId = subjectRootId(subjectId);
  const created = await createKnowledgeNodeFromEvents(
    tx,
    {
      id: rootId,
      name: displayName,
      domain: subjectId,
      parent_id: null,
      proposed_by_ai: false,
      created_at: new Date(),
    },
    { actorRef: 'subject-root-create' },
    'skip',
  );
  return { created, rootId };
}

/** Caller owns control authorization and CAS; the root mutation shares its transaction. */
export async function updateSubjectRootNameFromControl(
  tx: Tx,
  args: {
    subjectId: string;
    nextName: string;
    controlAction: 'rename' | 'reset';
  },
): Promise<void> {
  const rootId = subjectRootId(args.subjectId);
  const [root] = await tx
    .select()
    .from(knowledge)
    .where(eq(knowledge.id, rootId))
    .limit(1)
    .for('update');
  // Legacy/test rows can exist without a root. With no knowledge row there is no
  // mutation to fold; a later ensureSubjectRoot writes the genesis with displayName.
  if (!root) return;
  await requireKnowledgeHistory(tx, root);

  // Stamp the materialization after the root row lock. A knowledge proposal can
  // mutate this root without the control-plane lock; reusing an earlier timestamp
  // would let replay order this rename before the mutation we just observed.
  const materializedAt = new Date();
  const nextVersion = root.version + 1;

  await writeEvent(tx, {
    id: newId(),
    actor_kind: 'user',
    actor_ref: 'owner',
    action: 'experimental:subject_root_name_update',
    subject_kind: 'knowledge',
    subject_id: rootId,
    outcome: 'success',
    payload: {
      control_action: args.controlAction,
      subject_id: args.subjectId,
      previous_name: root.name,
      next_name: args.nextName,
      previous_version: root.version,
      next_version: nextVersion,
    },
    created_at: materializedAt,
    // Control-plane structure, not learner evidence: keep it out of the Mem0/brief outbox.
    ingest_at: materializedAt,
  });
  await projectKnowledgeNodeGuarded(tx, rootId);
}
