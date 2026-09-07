import { eq } from 'drizzle-orm';
import { emitArtifactLifecycleEvent } from '@/capabilities/notes/public';
import type { Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { projectLearningItemGuarded } from '@/server/projections/learning_item';
import { projectMistakeVariantGuarded } from '@/server/projections/mistake_variant';
import {
  assertKnowledgeNodeParity,
  hasLearningItemGenesisAnchor,
  hasMistakeVariantGenesisAnchor,
  knowledgeLiveRowToSnapshot,
} from '@/server/projections/parity';

export type { ProposalInboxRow } from '@/kernel/proposals/inbox';
export {
  ensureProposalDecisionSignal,
  recordProposalDecisionSignal,
} from '@/kernel/proposals/signals';
export {
  acquireProposalDecisionLock,
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  findExistingRateEvent,
  requiredString,
  writeProposalRateEvent,
} from './applier-helpers';
export {
  hasLearningItemGenesisAnchor,
  hasMistakeVariantGenesisAnchor,
  projectLearningItemGuarded,
  projectMistakeVariantGuarded,
};

export async function assertCurrentKnowledgeNodeParity(tx: Tx, nodeId: string): Promise<void> {
  const [row] = await tx.select().from(knowledge).where(eq(knowledge.id, nodeId));
  await assertKnowledgeNodeParity(tx, nodeId, row ? knowledgeLiveRowToSnapshot(row) : null);
}

export async function emitProposalArtifactArchive(
  tx: Tx,
  input: {
    artifactId: string;
    version: number;
    proposalId: string;
    archivedAt: Date;
  },
): Promise<void> {
  await emitArtifactLifecycleEvent(tx, {
    subjectId: input.artifactId,
    op: 'archive',
    archivedAt: input.archivedAt,
    nextVersion: input.version,
    actorKind: 'user',
    actorRef: 'self',
    causedByEventId: input.proposalId,
    createdAt: input.archivedAt,
  });
}
