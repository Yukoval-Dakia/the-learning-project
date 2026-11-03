import { eq } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { knowledgeLiveRowToSnapshot } from '@/kernel/records/knowledge-node-history';
import { assertKnowledgeNodeParity } from '@/server/projections/parity';

export { recordProposalDecisionSignal } from '@/kernel/proposals/signals';

export async function assertCurrentKnowledgeNodeParity(tx: Tx, nodeId: string): Promise<void> {
  const [row] = await tx.select().from(knowledge).where(eq(knowledge.id, nodeId));
  await assertKnowledgeNodeParity(tx, nodeId, row ? knowledgeLiveRowToSnapshot(row) : null);
}
