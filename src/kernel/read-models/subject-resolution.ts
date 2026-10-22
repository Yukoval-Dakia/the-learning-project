// Knowledge -> subject resolution bridge. Review scheduling and activity-gated
// refresh share this path: knowledge_ids[0] -> effective domain -> profile id, so
// the two cannot diverge.
//
// Unresolvable knowledge ids fall back to the default profile rather than dropping
// the row.

import type { Db, Tx } from '@/db/client';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import {
  type SubjectRegistry,
  getDefaultSubjectRegistry,
  normalizeSubjectKey,
  resolveKnownSubjectId,
  resolveSubjectProfile,
} from '@/subjects/profile';

/**
 * Resolve render notation from the server's resolvable registry, not the learner
 * selectable list. Retired custom subjects remain registered specifically so
 * historical questions keep their original rendering semantics.
 */
export function resolveSubjectRenderNotation(
  subjectId: string | null,
  registry: SubjectRegistry = getDefaultSubjectRegistry(),
): string | null {
  return registry.resolve(subjectId).renderConfig.notation ?? null;
}

// Resolve each unique first knowledge id once and reuse, avoiding an N+1 tree walk.
// db is explicit so tests and the nightly sweep can drive it.
export async function batchResolveSubjectIds(
  db: Db | Tx,
  rows: Array<{ id: string; knowledge_ids: string[] }>,
): Promise<Map<string, string>> {
  const defaultSubjectId = resolveSubjectProfile(null).id;
  const firstIdToSubjectId = new Map<string, string>();
  const pendingFirstIds = new Set<string>();
  for (const row of rows) {
    const firstId = row.knowledge_ids[0];
    if (firstId && !firstIdToSubjectId.has(firstId)) pendingFirstIds.add(firstId);
  }
  const uniqueFirstIds = [...pendingFirstIds];
  if (uniqueFirstIds.length > 0) {
    const domains = await Promise.all(
      uniqueFirstIds.map((kid) =>
        // Log before defaulting so a resolution failure stays observable; a null
        // domain still falls back to the default profile.
        getEffectiveDomain(db, kid).catch((error) => {
          console.warn(
            `[batchResolveSubjectIds] getEffectiveDomain failed for knowledge_id=${kid}; defaulting to null domain: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }),
      ),
    );
    uniqueFirstIds.forEach((kid, idx) => {
      // Same domain -> profile mapping as resolveSubjectProfileForKnowledgeIds,
      // without re-walking the tree.
      firstIdToSubjectId.set(kid, resolveSubjectProfile(domains[idx]).id);
    });
  }
  const out = new Map<string, string>();
  for (const row of rows) {
    const firstId = row.knowledge_ids[0];
    out.set(row.id, (firstId && firstIdToSubjectId.get(firstId)) || defaultSubjectId);
  }
  return out;
}

/**
 * Learner-facing variant: never turn an unknown-but-real domain into `general`.
 * Preserve the canonical id, else the normalized raw domain; null only when no
 * subject signal resolves.
 */
export async function batchResolveSubjectDisplayIds(
  db: Db | Tx,
  rows: Array<{ id: string; knowledge_ids: string[] }>,
): Promise<Map<string, string | null>> {
  const firstIdToSubjectId = new Map<string, string | null>();
  const uniqueFirstIds = [...new Set(rows.flatMap((row) => row.knowledge_ids[0] ?? []))];

  if (uniqueFirstIds.length > 0) {
    const domains = await Promise.all(
      uniqueFirstIds.map((kid) =>
        getEffectiveDomain(db, kid).catch((error) => {
          console.warn(
            `[batchResolveSubjectDisplayIds] getEffectiveDomain failed for knowledge_id=${kid}; displaying unassigned: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }),
      ),
    );
    uniqueFirstIds.forEach((kid, index) => {
      const domain = domains[index];
      firstIdToSubjectId.set(
        kid,
        resolveKnownSubjectId(domain) ?? (domain ? normalizeSubjectKey(domain) : null),
      );
    });
  }

  return new Map(
    rows.map((row) => {
      const firstId = row.knowledge_ids[0];
      return [row.id, firstId ? (firstIdToSubjectId.get(firstId) ?? null) : null];
    }),
  );
}
