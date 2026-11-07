// Reference answers agency owes the inbox's batch-undo guard.
//
// Agency creates the rows that point at an auto-created knowledge node: learning
// items carry `knowledge_ids` and goals carry `scope_knowledge_ids`. Either is
// later content, so retracting the node would orphan it. Reads agency's own rows.

import { and, isNull, or, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { goal } from '@/db/schema/learner-state';
import { learning_item } from '@/db/schema/learning';

type DbLike = Db | Tx;

/** Live learning items whose `knowledge_ids` include the node. */
export async function knowledgeNodesWithLearningItems(
  db: DbLike,
  nodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = new Set(nodeIds);
  if (wanted.size === 0) return new Set();
  const rows = await db
    .select({ knowledgeIds: learning_item.knowledge_ids })
    .from(learning_item)
    .where(
      and(
        isNull(learning_item.archived_at),
        or(
          ...[...wanted].map(
            (id) => sql`${learning_item.knowledge_ids} @> jsonb_build_array(${id}::text)`,
          ),
        ),
      ),
    );
  const used = new Set<string>();
  for (const row of rows) {
    for (const id of row.knowledgeIds ?? []) {
      if (wanted.has(id)) used.add(id);
    }
  }
  return used;
}

/** Goals whose `scope_knowledge_ids` cover the node. */
export async function knowledgeNodesWithGoalScopes(
  db: DbLike,
  nodeIds: readonly string[],
): Promise<ReadonlySet<string>> {
  const wanted = new Set(nodeIds);
  if (wanted.size === 0) return new Set();
  const rows = await db
    .select({ scopeKnowledgeIds: goal.scope_knowledge_ids })
    .from(goal)
    .where(
      or(
        ...[...wanted].map(
          (id) => sql`${goal.scope_knowledge_ids} @> jsonb_build_array(${id}::text)`,
        ),
      ),
    );
  const used = new Set<string>();
  for (const row of rows) {
    for (const id of row.scopeKnowledgeIds ?? []) {
      if (wanted.has(id)) used.add(id);
    }
  }
  return used;
}
