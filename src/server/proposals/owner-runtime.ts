import type { Tx } from '@/db/client';
import { goal, knowledge, learning_item, mistake_variant } from '@/db/schema';
import { emitArtifactLifecycleEvent } from '@/server/artifacts/mutation-events';
import { projectGoalGuarded } from '@/server/projections/goal';
import { projectLearningItemGuarded } from '@/server/projections/learning_item';
import { upsertMaterializedIdIndex } from '@/server/projections/materialized-id-index';
import { projectMistakeVariantGuarded } from '@/server/projections/mistake_variant';
import {
  assertGoalParity,
  assertKnowledgeNodeParity,
  assertLearningItemParity,
  assertMistakeVariantParity,
  goalLiveRowToSnapshot,
  hasGoalGenesisAnchor,
  hasLearningItemGenesisAnchor,
  hasMistakeVariantGenesisAnchor,
  knowledgeLiveRowToSnapshot,
  learningItemLiveRowToSnapshot,
  mistakeVariantLiveRowToSnapshot,
} from '@/server/projections/parity';
import { projectionIsWriter } from '@/server/projections/sot-flag';
import { eq } from 'drizzle-orm';

export {
  asPlainRecord,
  ensureAcceptOnly,
  existingAcceptRate,
  findExistingRateEvent,
  requiredString,
  writeProposalRateEvent,
} from './applier-helpers';
export type { ProposalInboxRow } from './inbox';
export { ensureProposalDecisionSignal, recordProposalDecisionSignal } from './signals';
export {
  hasGoalGenesisAnchor,
  hasLearningItemGenesisAnchor,
  hasMistakeVariantGenesisAnchor,
  projectGoalGuarded,
  projectLearningItemGuarded,
  projectMistakeVariantGuarded,
  projectionIsWriter,
  upsertMaterializedIdIndex,
};

export function learningItemSnapshot(row: typeof learning_item.$inferSelect): unknown {
  return learningItemLiveRowToSnapshot(row);
}

export async function assertCurrentLearningItemParity(tx: Tx, itemId: string): Promise<void> {
  const [row] = await tx.select().from(learning_item).where(eq(learning_item.id, itemId));
  await assertLearningItemParity(tx, itemId, row ? learningItemLiveRowToSnapshot(row) : null);
}

export async function assertCurrentGoalParity(tx: Tx, goalId: string): Promise<void> {
  const [row] = await tx.select().from(goal).where(eq(goal.id, goalId));
  await assertGoalParity(tx, goalId, row ? goalLiveRowToSnapshot(row) : null);
}

export async function assertCurrentKnowledgeNodeParity(tx: Tx, nodeId: string): Promise<void> {
  const [row] = await tx.select().from(knowledge).where(eq(knowledge.id, nodeId));
  await assertKnowledgeNodeParity(tx, nodeId, row ? knowledgeLiveRowToSnapshot(row) : null);
}

export async function assertCurrentMistakeVariantParity(tx: Tx, variantId: string): Promise<void> {
  const [row] = await tx.select().from(mistake_variant).where(eq(mistake_variant.id, variantId));
  await assertMistakeVariantParity(
    tx,
    variantId,
    row ? mistakeVariantLiveRowToSnapshot(row) : null,
  );
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
