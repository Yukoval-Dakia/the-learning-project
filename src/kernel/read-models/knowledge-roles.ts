// YUK-1600 — knowledge-node identity-role read seam.
//
// `knowledge.role` marks a node as a testable knowledge component ('kc', the default and
// all pre-column behavior) or as a goal/container that mastery machinery must leave
// alone. Every θ/PFA/FSRS write gate, supply/selection candidate gate and mastery read
// gate keys on ONE rule: role !== 'kc' ⇒ 不评掌握 (mastery is not evaluated).
//
// Default-open semantics: an id with no live knowledge row is NOT reported as non-kc —
// only a node that positively carries a non-kc role is dropped. Unknown/legacy ids keep
// their existing behavior, so the marker can never silently widen into an outage.

import { and, inArray, ne } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';

type DbLike = Db | Tx;

/** The identity-role vocabulary. Stored on knowledge.role; fold-owned structural truth. */
export type KnowledgeRole = 'kc' | 'goal' | 'container';

export const KNOWLEDGE_ROLE_VALUES: readonly KnowledgeRole[] = ['kc', 'goal', 'container'];

function normalizeIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

/**
 * The subset of `ids` that positively carries a non-kc role (goal / container). Ids with
 * no live knowledge row are absent from the result — the gate is deliberately default-open.
 */
export async function getNonKcKnowledgeIds(
  db: DbLike,
  ids: readonly string[],
): Promise<Set<string>> {
  const normalized = normalizeIds(ids);
  if (normalized.length === 0) return new Set();
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(inArray(knowledge.id, normalized), ne(knowledge.role, 'kc')));
  return new Set(rows.map((r) => r.id));
}

/**
 * Order-preserving filter that drops positively non-kc ids — the shared "mastery-evaluable
 * subset" used by the θ/PFA/FSRS write gates and the supply/selection candidate gates.
 */
export async function withoutNonKcKnowledgeIds(
  db: DbLike,
  ids: readonly string[],
): Promise<string[]> {
  const nonKc = await getNonKcKnowledgeIds(db, ids);
  if (nonKc.size === 0) return normalizeIds(ids);
  return normalizeIds(ids).filter((id) => !nonKc.has(id));
}
