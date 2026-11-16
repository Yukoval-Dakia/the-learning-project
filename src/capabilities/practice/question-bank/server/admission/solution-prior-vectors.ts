// Vectors for the solution prior's method and pitfall facets. Rebuildable from the prior
// rows. Anything compared against the method vectors must embed the same text shape (core
// idea + key step) with the same embedder and version.

import { sql } from 'drizzle-orm';
import { EMBED_VERSION, embedHash } from '@/core/embed-source';
import type { Db } from '@/db/client';
import {
  question_revision,
  question_solution_prior,
  question_solution_prior_vector,
} from '@/db/schema';
import { sourceAllowsDerivationSql } from '@/kernel/read-models/usage-policy';
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

// Leaves the provider call in flight room to finish before the attempt deadline.
const DEADLINE_MARGIN_MS = 3_000;

/**
 * Embed up to `limit` parts that have no vectors or vectors behind EMBED_VERSION. Each part
 * commits on its own, so a run that hits its deadline keeps its progress and the next run
 * continues; the nightly signal looks at parts, so a part is never left half-written.
 * Priors are frozen, so the text of a vector at the current version cannot have changed.
 * Returns vectors written.
 */
export async function embedSolutionPriorVectors(
  db: Db,
  limit: number,
  providerAttempt: EmbedProviderAttemptOptions,
  /** Test seam, threaded through by runEmbedBackfill's own embedFn. */
  embedFn: typeof embedMany = embedMany,
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
          )
          -- Facet text derives from the question; a prior produced before consent
          -- was restricted must not leak derived text to the embedder either. An
          -- unresolvable revision→question link fails closed.
          AND EXISTS (
            SELECT 1 FROM ${question_revision} r
            WHERE r.revision_id = ${question_solution_prior.revision_id}
              AND ${sourceAllowsDerivationSql({ kind: 'question', id: sql`r.group_id` })}
          )`,
    )
    .limit(limit);
  const deadline = providerAttempt.deadlineAt?.getTime();
  let written = 0;
  for (const row of priors) {
    if (deadline !== undefined && Date.now() > deadline - DEADLINE_MARGIN_MS) break;
    const part = SolutionPriorPart.safeParse(row.prior);
    if (!part.success) continue;
    const facets = solutionPriorFacetTexts(part.data);
    const vectors = await embedFn(
      facets.map((facet) => facet.text),
      providerAttempt,
    );
    await db.transaction(async (tx) => {
      for (const [i, facet] of facets.entries()) {
        const values = {
          embedding: vectors[i] as number[],
          embed_model: EMBED_MODEL,
          embed_version: EMBED_VERSION,
          content_hash: embedHash(facet.text),
        };
        await tx
          .insert(question_solution_prior_vector)
          .values({
            revision_id: row.revision_id,
            part_id: row.part_id,
            facet: facet.facet,
            idx: facet.idx,
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
    written += facets.length;
  }
  return written;
}
