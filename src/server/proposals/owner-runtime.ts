import { eq } from 'drizzle-orm';

export { archiveProposalArtifacts } from '@/capabilities/notes/public';

import type { Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { knowledgeLiveRowToSnapshot } from '@/kernel/records/knowledge-node-history';
import {
  hasLearningItemGenesisAnchor,
  projectLearningItemGuarded,
} from '@/kernel/records/learning-items';
import {
  hasMistakeVariantGenesisAnchor,
  projectMistakeVariantGuarded,
} from '@/kernel/records/mistake-variant-facts';
import { assertKnowledgeNodeParity } from '@/server/projections/parity';

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
