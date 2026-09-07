import { and, eq, isNull } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import { artifact, learning_item } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ProposalRetractInput } from '@/kernel/proposals';
export interface LearningItemRetractRuntime {
  emitProposalArtifactArchive: (
    tx: Tx,
    input: { artifactId: string; version: number; proposalId: string; archivedAt: Date },
  ) => Promise<void>;
  hasLearningItemGenesisAnchor: (tx: Tx, itemId: string) => Promise<boolean>;
  projectLearningItemGuarded: (tx: Tx, itemId: string) => Promise<unknown>;
}

export async function retractLearningItemProposal(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: LearningItemRetractRuntime,
): Promise<void> {
  const affectedItems = await tx
    .select()
    .from(learning_item)
    .where(and(eq(learning_item.source_ref, input.proposalId), isNull(learning_item.archived_at)))
    .for('update');

  for (const item of affectedItems) {
    if (!(await runtime.hasLearningItemGenesisAnchor(tx, item.id))) {
      throw new Error('learning_item requires canonical projection migration before retraction');
    }
    await writeEvent(tx, {
      id: newId(),
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:learning_item_archive',
      subject_kind: 'learning_item',
      subject_id: item.id,
      outcome: 'success',
      payload: { reason: 'proposal_retracted' },
      caused_by_event_id: input.proposalId,
      created_at: input.correction_at,
      ingest_at: input.correction_at,
    });
  }

  for (const item of affectedItems) await runtime.projectLearningItemGuarded(tx, item.id);

  const archivedArtifacts = await tx
    .update(artifact)
    .set({ archived_at: input.correction_at, updated_at: input.correction_at })
    .where(and(eq(artifact.source_ref, input.proposalId), isNull(artifact.archived_at)))
    .returning({ id: artifact.id, version: artifact.version });
  for (const archivedArtifact of archivedArtifacts) {
    await runtime.emitProposalArtifactArchive(tx, {
      artifactId: archivedArtifact.id,
      version: archivedArtifact.version,
      proposalId: input.proposalId,
      archivedAt: input.correction_at,
    });
  }
}
