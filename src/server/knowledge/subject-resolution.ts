// Knowledge → subject resolution bridge (T-CS / YUK-168, shared per P5.2).
//
// Extracted from `src/server/review/due-list.ts` so it is a first-class shared
// utility rather than a private detail of the review handler: both the review
// scheduler (cross-subject round-robin) and the P5.2 activity-gated brief
// refresh resolve "which subject does this knowledge belong to" through the
// SAME canonical bridge — `knowledge_ids[0] → getEffectiveDomain →
// resolveSubjectProfile.id` (BR-4) — so the two paths can never diverge
// (P5.2 spec §3.2, acceptance §7 "subject resolution matches the review
// scheduler").
//
// Orphan / missing knowledge ids (no row, or a row with no knowledge_ids) fall
// back to the default subject profile id (YUK-56), so any unresolvable id
// refreshes the default subject's brief / joins the default subject's review
// bucket rather than being dropped.

import type { Db } from '@/db/client';
import { getEffectiveDomain } from '@/server/knowledge/domain';
import { resolveSubjectProfile } from '@/subjects/profile';

// T-CS / YUK-168 — batch-resolve each row's learning-subject id from its first
// knowledge id, deduplicating the parent-chain walk. A naive per-row resolve
// would re-walk the knowledge tree once per row (N+1); here we resolve each
// UNIQUE first-knowledge-id once (via getEffectiveDomain) and reuse.
//
// `db` is threaded explicitly (not the module-level singleton) so DB tests can
// drive it against the testcontainer, and so the P5.2 nightly sweep can reuse it
// with the same Db it already holds.
export async function batchResolveSubjectIds(
  db: Db,
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
        // YUK-171 (#207) — log before defaulting so a transient / structural
        // failure in the domain-resolution chain is observable instead of
        // silently swallowed. Behaviour unchanged: a null domain still falls
        // back to the default subject profile via resolveSubjectProfile.
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
      // resolveSubjectProfile maps domain → profile via the alias table and
      // falls back to default for unknown/null domains, mirroring
      // resolveSubjectProfileForKnowledgeIds without re-walking the tree.
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
