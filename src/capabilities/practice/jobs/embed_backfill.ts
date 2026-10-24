// Idempotent embed backfill: fills question and knowledge rows whose embedding is
// NULL or stamped behind EMBED_VERSION. A rerun with no matching rows is a no-op;
// bumping EMBED_VERSION re-embeds older rows in the background.
//
// Provider failure leaves rows untouched and fails the job, so pg-boss retries on
// the next run. Question insert never calls this job, so ingestion is unaffected.
//
// Edits that change embed source text NULL the embedding — question writes and KC
// reparents — so this job re-embeds them with fresh text and a fresh content hash.

import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import {
  EMBED_VERSION,
  embedHash,
  knowledgeEmbedText,
  questionEmbedText,
} from '@/core/embed-source';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import {
  EMBED_DIMS,
  EMBED_MODEL,
  type EmbedProviderAttemptOptions,
  embedMany,
} from '@/server/ai/embed';

/** Stamp a vector computed during ingest; valid only when its text is the text about
 *  to be persisted. Otherwise leave it NULL for the backfill to recompute. */
export function questionEmbedStamp(
  q: {
    prompt_md: string;
    reference_md: string | null;
    choices_md: string[] | null;
  },
  vector: number[],
): {
  embedding: number[];
  embed_model: string;
  embed_version: number;
  embed_content_hash: string;
} | null {
  if (vector.length !== EMBED_DIMS) return null;
  return {
    embedding: vector,
    embed_model: EMBED_MODEL,
    embed_version: EMBED_VERSION,
    embed_content_hash: embedHash(questionEmbedText(q)),
  };
}

export async function embedQuestionTextForIngest(
  q: {
    prompt_md: string;
    reference_md: string | null;
    choices_md: string[] | null;
  },
  providerAttempt: EmbedProviderAttemptOptions,
): Promise<number[]> {
  const [vector] = await embedMany([questionEmbedText(q)], providerAttempt);
  if (vector == null || vector.length !== EMBED_DIMS) {
    throw new Error('ingest embed returned no usable vector');
  }
  return vector;
}

export type QuestionVectorInvalidReason =
  | 'no_vector'
  | 'dimension_mismatch'
  | 'stale_version'
  | 'hash_mismatch';

/** A stored vector is usable only when present, EMBED_DIMS wide, stamped EMBED_VERSION,
 *  and hashed from the row's CURRENT content (an edit not yet re-embedded leaves a stale
 *  vector). Returns the first failing check, or null. Shared with the search_bank
 *  similar_to anchor and the embed census so they cannot drift from this job. */
export function questionVectorInvalidReason(row: {
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  embed_version: number | null;
  embed_content_hash: string | null;
  /** Stored vector width; null when the row has no vector. */
  dimension: number | null;
}): QuestionVectorInvalidReason | null {
  if (row.dimension === null) return 'no_vector';
  if (row.dimension !== EMBED_DIMS) return 'dimension_mismatch';
  if (row.embed_version !== EMBED_VERSION) return 'stale_version';
  if (row.embed_content_hash !== embedHash(questionEmbedText(row))) return 'hash_mismatch';
  return null;
}

// Each getEffectiveDomain call walks up to 32 ancestors with serial SELECTs, so resolving
// the batch sequentially multiplies that. Chunked parallelism cuts latency without
// opening one connection per row (kept below the default pool size).
const EFFECTIVE_DOMAIN_CONCURRENCY = 8;

/** Embed up to `limit` stale question and knowledge rows, stamping model, version, and
 *  content hash. Returns the number embedded; rerunning is safe. */
export async function runEmbedBackfill(
  db: Db,
  limit = 100,
  providerAttempt: EmbedProviderAttemptOptions = {
    db,
    caller: 'worker',
    deadlineAt: new Date(Date.now() + 20_000),
  },
): Promise<number> {
  let total = 0;

  // Re-embed when the vector is missing (never embedded / edit-NULLed) or stamped
  // behind EMBED_VERSION. `lt` is not NULL-tolerant, so legacy rows need the
  // explicit isNull(embed_version) branch.
  const qStale = or(
    isNull(question.embedding),
    isNull(question.embed_version),
    lt(question.embed_version, EMBED_VERSION),
  );
  const qs = await db.select().from(question).where(qStale).limit(limit);
  if (qs.length > 0) {
    const texts = qs.map((q) => questionEmbedText(q));
    const vecs = await embedMany(texts, providerAttempt);
    for (let i = 0; i < qs.length; i++) {
      // A content edit during the provider call invalidates this result even if the
      // row still needs an embedding; match the selected source null-safely.
      const sourceStillCurrent = and(
        eq(question.id, qs[i].id),
        qStale,
        sql`${question.prompt_md} IS NOT DISTINCT FROM ${qs[i].prompt_md}`,
        sql`${question.reference_md} IS NOT DISTINCT FROM ${qs[i].reference_md}`,
        sql`${question.choices_md} IS NOT DISTINCT FROM ${qs[i].choices_md === null ? null : JSON.stringify(qs[i].choices_md)}::jsonb`,
        sql`${question.embed_content_hash} IS NOT DISTINCT FROM ${qs[i].embed_content_hash}`,
      );
      const written = await db
        .update(question)
        .set({
          embedding: vecs[i],
          embed_model: EMBED_MODEL,
          embed_version: EMBED_VERSION,
          embed_content_hash: embedHash(texts[i]),
        })
        .where(sourceStillCurrent)
        .returning({ id: question.id });
      total += written.length;
    }
  }

  const kStale = or(
    isNull(knowledge.embedding),
    isNull(knowledge.embed_version),
    lt(knowledge.embed_version, EMBED_VERSION),
  );
  const ks = await db.select().from(knowledge).where(kStale).limit(limit);
  if (ks.length > 0) {
    // Fold each KC's effective domain into its embed text so same-named cross-subject
    // KCs get distinct vectors and hashes. Resolve in bounded chunks; index alignment
    // keeps every row paired with its own domain.
    const resolved: { k: (typeof ks)[number]; text: string }[] = [];
    for (let start = 0; start < ks.length; start += EFFECTIVE_DOMAIN_CONCURRENCY) {
      const chunk = ks.slice(start, start + EFFECTIVE_DOMAIN_CONCURRENCY);
      const outcomes = await Promise.allSettled(chunk.map((k) => getEffectiveDomain(db, k.id)));
      for (let j = 0; j < chunk.length; j++) {
        const k = chunk[j];
        const outcome = outcomes[j];
        // A thrown resolution is transient (broken tree): skip the row rather than stamp
        // a degraded name-only vector. Leaving the prior version untouched makes the
        // select predicate re-pick it next run. getEffectiveDomain either returns a
        // domain or throws, so a rejected outcome is the only unresolvable case here.
        if (outcome.status === 'rejected') {
          console.warn(
            '[embed_backfill] skipping KC %s — effective-domain unresolved, will retry next run:',
            k.id,
            outcome.reason,
          );
          continue;
        }
        resolved.push({
          k,
          text: knowledgeEmbedText({ name: k.name, effectiveDomain: outcome.value }),
        });
      }
    }

    if (resolved.length > 0) {
      const vecs = await embedMany(
        resolved.map((r) => r.text),
        providerAttempt,
      );
      for (let i = 0; i < resolved.length; i++) {
        const { k, text } = resolved[i];
        await db
          .update(knowledge)
          .set({
            embedding: vecs[i],
            embed_model: EMBED_MODEL,
            embed_version: EMBED_VERSION,
            embed_content_hash: embedHash(text),
          })
          // Same concurrency guard as the question update above.
          .where(and(eq(knowledge.id, k.id), kStale));
      }
    }
    // Only rows with a correctly resolved domain are embedded and counted; skipped
    // rows stay re-pickable.
    total += resolved.length;
  }

  return total;
}

// A throw propagates to pg-boss for retry; rows stay NULL until the next run.
export function buildEmbedBackfillHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async (jobs) => {
    try {
      const embedded = await runEmbedBackfill(db, 100, {
        db,
        caller: 'worker',
        deadlineAt: new Date(Date.now() + 20_000),
        operationAnchor: jobs[0]?.id,
      });
      console.log('[embed_backfill] embedded', embedded);
    } catch (err) {
      console.error('[embed_backfill] failed', err);
      throw err;
    }
  };
}
