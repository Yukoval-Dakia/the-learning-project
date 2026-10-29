import { eq } from 'drizzle-orm';
import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { subjectRootId } from '@/kernel/records/knowledge-node-birth';
import { projectKnowledgeNodeGuarded } from '@/kernel/records/knowledge-node-materialization';
import { requireKnowledgeHistory } from './node-history-guard';

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
