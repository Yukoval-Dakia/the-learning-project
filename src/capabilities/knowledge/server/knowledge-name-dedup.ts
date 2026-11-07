// Same-name live-node lookup for `propose_new`: a child proposal reuses a live
// sibling with the same normalized name; a root proposal reuses a live root in
// the same domain. Both the propose gate (return the id for immediate use) and
// the accept path (hard guard against duplicates committed in parallel) call
// this through the same scope+name rule.

import { and, eq, isNull } from 'drizzle-orm';
import { normalizeKnowledgeNodeName } from '@/core/knowledge-name';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';

type DbLike = Db | Tx;

export interface SameNameKnowledgeScope {
  readonly name: string;
  readonly parentId: string | null;
  /** Root proposals only: the sanitized domain the root anchors. */
  readonly domain?: string;
  /** Restrict hits to one role: the authoring gate passes 'kc' so a reused
   * node_id is always an attachable knowledge point — never a container,
   * goal or seed root. The accept guard omits this so any same-name sibling
   * blocks a duplicate create. */
  readonly role?: 'kc' | 'goal' | 'container';
}

/**
 * Live same-scope same-name nodes, oldest first. Normalization is the shared
 * trim+NFC rule; there is no substring or semantic matching.
 */
export async function findLiveSameNameKnowledgeNodes(
  db: DbLike,
  scope: SameNameKnowledgeScope,
): Promise<Array<{ id: string; name: string }>> {
  const normalized = normalizeKnowledgeNodeName(scope.name);
  if (!normalized) return [];
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(
      scope.parentId === null
        ? and(
            isNull(knowledge.parent_id),
            eq(knowledge.domain, scope.domain ?? ''),
            isNull(knowledge.archived_at),
            ...(scope.role ? [eq(knowledge.role, scope.role)] : []),
          )
        : and(
            eq(knowledge.parent_id, scope.parentId),
            isNull(knowledge.archived_at),
            ...(scope.role ? [eq(knowledge.role, scope.role)] : []),
          ),
    )
    .orderBy(knowledge.created_at, knowledge.id);
  return rows.filter((row) => normalizeKnowledgeNodeName(row.name) === normalized);
}
