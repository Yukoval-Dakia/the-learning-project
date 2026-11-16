import { and, eq, isNull } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Tx } from '@/db/client';
import { learning_item } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import type { ProposalRetractInput } from '@/kernel/proposals';
import { requireLaterProposalCorrection } from '@/kernel/proposals/types';
import {
  hasLearningItemGenesisAnchor,
  projectLearningItemGuarded,
} from '@/kernel/records/learning-items';
import { learningIntentTopic, sealLearningIntentOutlineReceiptTx } from './learning-intent-request';

type ArchiveProposalArtifacts = (
  tx: Tx,
  input: { proposalId: string; archivedAt: Date },
) => Promise<void>;

/**
 * The retract dispatcher supplies the Notes archive so agency does not import Notes.
 * Without it the retract throws before touching anything and the whole correction rolls
 * back: leaving a retracted proposal's notes live is not an acceptable degradation.
 */
function archiveFromRuntime(runtime: unknown): ArchiveProposalArtifacts {
  const archive =
    runtime && typeof runtime === 'object'
      ? (runtime as { archiveProposalArtifacts?: unknown }).archiveProposalArtifacts
      : undefined;
  if (typeof archive !== 'function') {
    throw new Error('learning_item retract requires archiveProposalArtifacts in the runtime');
  }
  return archive as ArchiveProposalArtifacts;
}

export async function retractLearningItemProposal(
  tx: Tx,
  input: ProposalRetractInput,
  runtime: unknown,
): Promise<void> {
  const archiveProposalArtifacts = archiveFromRuntime(runtime);
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
    if (!(await hasLearningItemGenesisAnchor(tx, item.id))) {
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

  for (const item of affectedItems) await projectLearningItemGuarded(tx, item.id);

  await archiveProposalArtifacts(tx, {
    proposalId: input.proposalId,
    archivedAt: input.correction_at,
  });
  const topic = learningIntentTopic(input.proposal.payload);
  if (topic) await sealLearningIntentOutlineReceiptTx(tx, topic, input.proposalId);
}
