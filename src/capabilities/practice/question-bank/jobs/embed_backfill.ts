// Idempotent embed backfill: fills question and knowledge rows whose embedding is
// NULL or stamped behind EMBED_VERSION. A rerun with no matching rows is a no-op;
// bumping EMBED_VERSION re-embeds older rows in the background.
//
// Provider failure leaves rows untouched and fails the job, so pg-boss retries on
// the next run. Question insert never calls this job, so ingestion is unaffected.
//
// Edits that change embed source text NULL the embedding — question writes and KC
// reparents — so this job re-embeds them with fresh text and a fresh content hash.
//
// YUK-1603 — every embed write stamps embed_source_revision (the row revision the
// vector was computed from) under a revision CAS, so a late vector can never
// overwrite a newer revision's result; a provider-free currency sweep re-stamps
// provenance that merely fell behind and re-embeds rows whose content drifted
// under a surviving vector.

import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import {
  EMBED_VERSION,
  embedHash,
  knowledgeEmbedText,
  questionEmbedText,
} from '@/core/embed-source';
import type { Db } from '@/db/client';
import { isEmbedRevisionCurrent } from '@/db/embed-currency';
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
    version: number;
  },
  vector: number[],
): {
  embedding: number[];
  embed_model: string;
  embed_version: number;
  embed_content_hash: string;
  embed_source_revision: number;
} | null {
  if (vector.length !== EMBED_DIMS) return null;
  return {
    embedding: vector,
    embed_model: EMBED_MODEL,
    embed_version: EMBED_VERSION,
    embed_content_hash: embedHash(questionEmbedText(q)),
    embed_source_revision: q.version,
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
  | 'revision_mismatch'
  | 'hash_mismatch';

/** A stored vector is usable only when present, EMBED_DIMS wide, stamped EMBED_VERSION,
 *  stamped from the row's CURRENT revision (embed_source_revision), and hashed from the
 *  row's CURRENT content (an edit not yet re-embedded leaves a stale vector). Returns
 *  the first failing check, or null. Shared with the search_bank similar_to anchor and
 *  the embed census so they cannot drift from this job. */
export function questionVectorInvalidReason(row: {
  prompt_md: string;
  reference_md: string | null;
  choices_md: string[] | null;
  version: number;
  embed_version: number | null;
  embed_content_hash: string | null;
  embed_source_revision: number | null;
  /** Stored vector width; null when the row has no vector. */
  dimension: number | null;
}): QuestionVectorInvalidReason | null {
  if (row.dimension === null) return 'no_vector';
  if (row.dimension !== EMBED_DIMS) return 'dimension_mismatch';
  if (row.embed_version !== EMBED_VERSION) return 'stale_version';
  if (!isEmbedRevisionCurrent(row)) return 'revision_mismatch';
  if (row.embed_content_hash !== embedHash(questionEmbedText(row))) return 'hash_mismatch';
  return null;
}

// Each getEffectiveDomain call walks up to 32 ancestors with serial SELECTs, so resolving
// the batch sequentially multiplies that. Chunked parallelism cuts latency without
// opening one connection per row (kept below the default pool size).
const EFFECTIVE_DOMAIN_CONCURRENCY = 8;

// Order-preserving resolution used by both the embed pass and the currency sweep.
// A thrown resolution is transient (broken tree): the row is skipped with a warning so
// no caller stamps a degraded name-only vector, and the select predicate re-picks it
// next run. getEffectiveDomain either returns a domain or throws.
async function resolveKnowledgeEffectiveDomains<T extends { id: string }>(
  db: Db,
  rows: T[],
): Promise<Array<{ row: T; effectiveDomain: string }>> {
  const out: Array<{ row: T; effectiveDomain: string }> = [];
  for (let start = 0; start < rows.length; start += EFFECTIVE_DOMAIN_CONCURRENCY) {
    const chunk = rows.slice(start, start + EFFECTIVE_DOMAIN_CONCURRENCY);
    const outcomes = await Promise.allSettled(chunk.map((row) => getEffectiveDomain(db, row.id)));
    for (let j = 0; j < chunk.length; j++) {
      const outcome = outcomes[j];
      if (outcome.status === 'rejected') {
        console.warn(
          '[embed_backfill] skipping KC %s — effective-domain unresolved, will retry next run:',
          chunk[j].id,
          outcome.reason,
        );
        continue;
      }
      out.push({ row: chunk[j], effectiveDomain: outcome.value });
    }
  }
  return out;
}

// YUK-1603 — provider-free currency sweep over surviving vectors whose provenance fell
// behind the row revision (embed_source_revision NULL legacy rows, metadata-only edits,
// same-domain reparents). A vector whose recomputed content hash still matches is just
// re-stamped with the current revision — no embed call. A hash drift means content moved
// under a surviving vector (a missed invalidation): register the re-embed obligation the
// way editQuestion/applyReparent do — NULL the vector, stamp the new hash — so the stale
// passes in the same run re-embed the current text. Both writes CAS on the revision read
// plus the suspect predicate, so a concurrent embed write is never clobbered.
async function sweepQuestionEmbedCurrency(
  db: Db,
  limit: number,
): Promise<{ restamped: number; invalidated: number }> {
  const suspect = and(
    isNotNull(question.embedding),
    eq(question.embed_version, EMBED_VERSION),
    sql`${question.embed_source_revision} IS DISTINCT FROM ${question.version}`,
  );
  const rows = await db.select().from(question).where(suspect).limit(limit);
  let restamped = 0;
  let invalidated = 0;
  for (const row of rows) {
    const currentHash = embedHash(questionEmbedText(row));
    if (currentHash === row.embed_content_hash) {
      const written = await db
        .update(question)
        .set({ embed_source_revision: row.version })
        .where(
          and(
            eq(question.id, row.id),
            eq(question.version, row.version),
            sql`${question.embed_content_hash} IS NOT DISTINCT FROM ${row.embed_content_hash}`,
            suspect,
          ),
        )
        .returning({ id: question.id });
      restamped += written.length;
    } else {
      const written = await db
        .update(question)
        .set({ embedding: null, embed_content_hash: currentHash, embed_source_revision: null })
        .where(and(eq(question.id, row.id), eq(question.version, row.version), suspect))
        .returning({ id: question.id });
      invalidated += written.length;
    }
  }
  return { restamped, invalidated };
}

async function sweepKnowledgeEmbedCurrency(
  db: Db,
  limit: number,
): Promise<{ restamped: number; invalidated: number }> {
  const suspect = and(
    isNotNull(knowledge.embedding),
    eq(knowledge.embed_version, EMBED_VERSION),
    sql`${knowledge.embed_source_revision} IS DISTINCT FROM ${knowledge.version}`,
  );
  const rows = await db.select().from(knowledge).where(suspect).limit(limit);
  const resolved = await resolveKnowledgeEffectiveDomains(db, rows);
  let restamped = 0;
  let invalidated = 0;
  for (const { row, effectiveDomain } of resolved) {
    const currentHash = embedHash(knowledgeEmbedText({ name: row.name, effectiveDomain }));
    if (currentHash === row.embed_content_hash) {
      const written = await db
        .update(knowledge)
        .set({ embed_source_revision: row.version })
        .where(
          and(
            eq(knowledge.id, row.id),
            eq(knowledge.version, row.version),
            sql`${knowledge.name} IS NOT DISTINCT FROM ${row.name}`,
            sql`${knowledge.embed_content_hash} IS NOT DISTINCT FROM ${row.embed_content_hash}`,
            suspect,
          ),
        )
        .returning({ id: knowledge.id });
      restamped += written.length;
    } else {
      const written = await db
        .update(knowledge)
        .set({ embedding: null, embed_content_hash: currentHash, embed_source_revision: null })
        .where(
          and(
            eq(knowledge.id, row.id),
            eq(knowledge.version, row.version),
            sql`${knowledge.name} IS NOT DISTINCT FROM ${row.name}`,
            suspect,
          ),
        )
        .returning({ id: knowledge.id });
      invalidated += written.length;
    }
  }
  return { restamped, invalidated };
}

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

  // YUK-1603 — currency sweep first, so provenance repairs are free of provider calls
  // and sweep-invalidated rows are re-embedded by the stale passes in this same run.
  const qSweep = await sweepQuestionEmbedCurrency(db, limit);
  const kSweep = await sweepKnowledgeEmbedCurrency(db, limit);
  if (qSweep.restamped + qSweep.invalidated + kSweep.restamped + kSweep.invalidated > 0) {
    console.log('[embed_backfill] currency sweep', { question: qSweep, knowledge: kSweep });
  }

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
      // row still needs an embedding; match the selected source null-safely. The
      // revision CAS additionally rejects the write when a non-embed field changed,
      // so a late vector can never land as the current revision's result.
      const sourceStillCurrent = and(
        eq(question.id, qs[i].id),
        qStale,
        eq(question.version, qs[i].version),
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
          embed_source_revision: qs[i].version,
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
    // KCs get distinct vectors and hashes. Resolution keeps every row paired with its
    // own domain.
    const resolved = await resolveKnowledgeEffectiveDomains(db, ks);
    const pairs = resolved.map(({ row, effectiveDomain }) => ({
      k: row,
      text: knowledgeEmbedText({ name: row.name, effectiveDomain }),
    }));

    if (pairs.length > 0) {
      const vecs = await embedMany(
        pairs.map((r) => r.text),
        providerAttempt,
      );
      for (let i = 0; i < pairs.length; i++) {
        const { k, text } = pairs[i];
        await db
          .update(knowledge)
          .set({
            embedding: vecs[i],
            embed_model: EMBED_MODEL,
            embed_version: EMBED_VERSION,
            embed_content_hash: embedHash(text),
            embed_source_revision: k.version,
          })
          // Same concurrency guard as the question update above, plus selection-time
          // name/hash parity: a reparent that NULLed the embedding and stamped a new
          // hash (or a rename) must not let this late write land the old effective
          // domain's vector as current.
          .where(
            and(
              eq(knowledge.id, k.id),
              kStale,
              eq(knowledge.version, k.version),
              sql`${knowledge.name} IS NOT DISTINCT FROM ${k.name}`,
              sql`${knowledge.embed_content_hash} IS NOT DISTINCT FROM ${k.embed_content_hash}`,
            ),
          );
      }
    }
    // Only rows with a correctly resolved domain are embedded and counted; skipped
    // rows stay re-pickable.
    total += pairs.length;
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
