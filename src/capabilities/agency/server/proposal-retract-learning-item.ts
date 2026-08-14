import { and, eq, isNull } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import { artifact, learning_item } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ProposalRetractInput } from '@/kernel/proposals';
export interface LearningItemRetractRuntime {
  assertCurrentLearningItemParity: (tx: Tx, itemId: string) => Promise<void>;
  emitProposalArtifactArchive: (
    tx: Tx,
    input: { artifactId: string; version: number; proposalId: string; archivedAt: Date },
  ) => Promise<void>;
  hasLearningItemGenesisAnchor: (tx: Tx, itemId: string) => Promise<boolean>;
  learningItemSnapshot: (row: typeof learning_item.$inferSelect) => unknown;
  projectLearningItemGuarded: (tx: Tx, itemId: string) => Promise<unknown>;
  projectionIsWriter: (
    entity?: 'artifact' | 'goal' | 'learning_item' | 'mistake_variant' | 'question_block',
  ) => boolean;
  upsertMaterializedIdIndex: (
    tx: Tx,
    input: { materialized_id: string; anchor_event_id: string; subject_kind: 'learning_item' },
  ) => Promise<unknown>;
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
  const projectionWrites = runtime.projectionIsWriter('learning_item');

  for (const item of affectedItems) {
    if (!(await runtime.hasLearningItemGenesisAnchor(tx, item.id))) {
      const genesisEventId = newId();
      const genesisAt = new Date(
        Math.min(item.updated_at.getTime(), input.correction_at.getTime() - 1),
      );
      await writeEvent(tx, {
        id: genesisEventId,
        actor_kind: 'system',
        actor_ref: 'genesis-backfill',
        action: 'experimental:genesis',
        subject_kind: 'learning_item',
        subject_id: item.id,
        outcome: 'success',
        payload: { row: runtime.learningItemSnapshot(item) },
        created_at: genesisAt,
        ingest_at: input.correction_at,
      });
      await runtime.upsertMaterializedIdIndex(tx, {
        materialized_id: item.id,
        anchor_event_id: genesisEventId,
        subject_kind: 'learning_item',
      });
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

  if (projectionWrites) {
    for (const item of affectedItems) await runtime.projectLearningItemGuarded(tx, item.id);
  } else {
    await tx
      .update(learning_item)
      .set({
        archived_at: input.correction_at,
        archived_reason: 'proposal_retracted',
        updated_at: input.correction_at,
      })
      .where(
        and(eq(learning_item.source_ref, input.proposalId), isNull(learning_item.archived_at)),
      );
    for (const item of affectedItems) {
      await runtime.assertCurrentLearningItemParity(tx, item.id);
    }
  }

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
