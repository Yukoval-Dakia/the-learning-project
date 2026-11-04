// Vectors for the solution prior's method and pitfall facets. Rebuildable from the prior
// rows. The method text matches Backtrace's `method` facet (core idea + key step, same
// embedder and version), so the two can be compared by cosine directly.

import { sql } from 'drizzle-orm';
import { EMBED_VERSION, embedHash } from '@/core/embed-source';
import type { Db } from '@/db/client';
import { question_solution_prior, question_solution_prior_vector } from '@/db/schema';
import { EMBED_MODEL, type EmbedProviderAttemptOptions, embedMany } from '@/server/ai/embed';
import { SolutionPriorPart, type SolutionPriorPartT } from './solution-prior';

export interface SolutionPriorFacetText {
  facet: 'method' | 'pitfall';
  idx: number;
  text: string;
}

export function solutionPriorFacetTexts(part: SolutionPriorPartT): SolutionPriorFacetText[] {
  return [
    ...part.methods.map((m, idx) => ({
      facet: 'method' as const,
      idx,
      text: `${m.core_idea_md}\n${m.key_step_md}`,
    })),
    ...part.pitfalls.map((p, idx) => ({
      facet: 'pitfall' as const,
      idx,
      text: `${p.mechanism_md}\n${p.trigger_md}`,
    })),
  ];
}

/**
 * Embed up to `limit` parts that have no vectors or vectors behind EMBED_VERSION. A part
 * is written whole in one transaction: the nightly pending signal looks at parts, so a
 * half-written part would never be picked up again. Priors are frozen, so the text of a
 * vector at the current version cannot have changed. Returns vectors written.
 */
export async function embedSolutionPriorVectors(
  db: Db,
  limit: number,
  providerAttempt: EmbedProviderAttemptOptions,
): Promise<number> {
  const priors = await db
    .select()
    .from(question_solution_prior)
    .where(
      sql`NOT EXISTS (
            SELECT 1 FROM ${question_solution_prior_vector} v
            WHERE v.revision_id = ${question_solution_prior.revision_id}
              AND v.part_id = ${question_solution_prior.part_id}
              AND v.embed_version >= ${EMBED_VERSION}
          )`,
    )
    .limit(limit);
  const pending = priors.flatMap((row) => {
    const part = SolutionPriorPart.safeParse(row.prior);
    if (!part.success) return [];
    return solutionPriorFacetTexts(part.data).map((facet) => ({
      ...facet,
      revision_id: row.revision_id,
      part_id: row.part_id,
    }));
  });
  if (pending.length === 0) return 0;
  const vectors = await embedMany(
    pending.map((p) => p.text),
    providerAttempt,
  );
  await db.transaction(async (tx) => {
    for (const [i, p] of pending.entries()) {
      const values = {
        embedding: vectors[i] as number[],
        embed_model: EMBED_MODEL,
        embed_version: EMBED_VERSION,
        content_hash: embedHash(p.text),
      };
      await tx
        .insert(question_solution_prior_vector)
        .values({
          revision_id: p.revision_id,
          part_id: p.part_id,
          facet: p.facet,
          idx: p.idx,
          ...values,
        })
        .onConflictDoUpdate({
          target: [
            question_solution_prior_vector.revision_id,
            question_solution_prior_vector.part_id,
            question_solution_prior_vector.facet,
            question_solution_prior_vector.idx,
          ],
          set: values,
        });
    }
  });
  return pending.length;
}
