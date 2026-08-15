import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { and, inArray, isNull } from 'drizzle-orm';

export interface FailureLearningKnowledgeNode {
  id: string;
  name: string;
  effective_domain: string | null;
}

/**
 * Capability-owned bounded read for Failure Learning.
 *
 * The old attribution adapter loaded the complete knowledge tree and filtered it
 * in memory. This query reads only the active ids named by the attempt, then
 * resolves at most each requested node's 32-level ancestor chain. Output order
 * follows the caller's first occurrence so profile selection is deterministic.
 */
export async function loadFailureLearningKnowledgeContext(
  db: Db | Tx,
  knowledgeIds: readonly string[],
): Promise<FailureLearningKnowledgeNode[]> {
  const requested = [...new Set(knowledgeIds.map((id) => id.trim()).filter(Boolean))];
  if (requested.length === 0) return [];

  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name, domain: knowledge.domain })
    .from(knowledge)
    .where(and(inArray(knowledge.id, requested), isNull(knowledge.archived_at)));
  const byId = new Map(rows.map((row) => [row.id, row]));

  const resolved = await Promise.all(
    requested.map(async (id): Promise<FailureLearningKnowledgeNode | null> => {
      const row = byId.get(id);
      if (!row) return null;
      let effectiveDomain: string | null = null;
      try {
        effectiveDomain = await getEffectiveDomain(db, id);
      } catch {
        // Preserve the former tool adapter's fallback for a broken ancestor:
        // the node's own domain is still a useful lower-bound subject signal.
        effectiveDomain = row.domain;
      }
      return { id: row.id, name: row.name, effective_domain: effectiveDomain };
    }),
  );
  return resolved.filter((node): node is FailureLearningKnowledgeNode => node !== null);
}
