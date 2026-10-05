import { and, eq, isNull } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import { learning_item } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ProposalRetractInput } from '@/kernel/proposals';
import { requireLaterProposalCorrection } from '@/kernel/proposals/types';
export interface LearningItemRetractRuntime {
  archiveProposalArtifacts: (
    tx: Tx,
    input: { proposalId: string; archivedAt: Date },
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

  if (affectedItems.length > 0) {
    requireLaterProposalCorrection(
      input.correction_at,
      new Date(Math.max(...affectedItems.map((item) => item.updated_at.getTime()))),
    );
  }
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

  await runtime.archiveProposalArtifacts(tx, {
    proposalId: input.proposalId,
    archivedAt: input.correction_at,
  });
}
