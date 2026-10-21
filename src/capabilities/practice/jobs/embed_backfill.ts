// YUK-383 Phase 0 — idempotent embed backfill job. One job covers all four
// cases: existing-corpus backfill, next-day new rows, embed-API-failure retry
// (§9 fallback: a question is inserted with embedding NULL unless ingest already
// stamped the vector it computed for near-dup; this nightly job fills the rest),
// AND (YUK-393) corpus re-embed when EMBED_VERSION bumps.
// Idempotent because the select predicate is `embedding IS NULL OR
// embed_version < EMBED_VERSION` — a second run with no matching rows is a no-op.
// embed_version stamps which join rule / model produced the vector; bump
// EMBED_VERSION to trigger a background re-embed of older-version rows.
// embedMany throwing (API down) fails the job and leaves rows untouched →
// pg-boss retries next run; the question-insert path never calls this job, so
// ingestion is unaffected.
//
// YUK-393 — re-embed-on-change wiring (the formerly DEFERRED "embed-on-write"):
//   • editQuestion (src/server/questions/write.ts) NULLs a question's embedding
//     when prompt_md/reference_md/choices_md change (hash mismatch);
//   • applyReparent (src/capabilities/knowledge/server/proposals.ts) NULLs a
//     moved KC's embedding when its effective-domain hash changes (cross-domain
//     move) — KC-only, never cascaded to the question subtree.
// Those edits drop the row back to `embedding IS NULL`, so THIS job picks it up
// and re-embeds with the fresh source text + stamps a fresh embed_content_hash.
// Each KC's embed text now folds its EFFECTIVE domain (getEffectiveDomain walk),
// disambiguating same-named cross-subject KCs.

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

export { EMBED_VERSION };

/** 入库已经算过的向量。文本必须是即将落库的题面，否则不要写，留给本任务重算。 */
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

/** YUK-1448 — is a stored question vector usable as-is? Valid only when it is present,
 *  EMBED_DIMS wide, stamped EMBED_VERSION, and hashed from the row's CURRENT content
 *  (an edit that has not been re-embedded yet leaves a stale vector). Returns the first
 *  failing check, or null when valid. Shared by the search_bank similar_to anchor and
 *  the `pnpm embed:inventory` census so neither drifts from what this job writes. */
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

// YUK-393 F2 — bound the parallel effective-domain resolution. Each
// getEffectiveDomain call issues up to MAX_DEPTH(32) serial SELECTs (one per
// ancestor hop); resolving the whole batch sequentially is ~limit×32 serial
// round-trips. Resolve in fixed-size chunks instead — parallel within a chunk,
// sequential across chunks — so we cut latency without opening one connection
// per row (pool exhaustion). Chosen below the default postgres pool size.
const EFFECTIVE_DOMAIN_CONCURRENCY = 8;

/** Idempotent: embed up to `limit` question rows + `limit` knowledge rows whose
 *  embedding IS NULL OR whose embed_version is behind EMBED_VERSION, stamping
 *  model + version + content-hash. Returns the number embedded. */
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

  // Re-embed predicate (YUK-393): NULL embedding (never embedded / edit-NULLed)
  // OR a row stamped behind the current EMBED_VERSION (corpus re-embed). A NULL
  // embed_version (legacy / pre-version rows) also satisfies the staleness intent;
  // `lt(embed_version, EMBED_VERSION)` is NULL-tolerant only via the OR isNull
  // branch, so include isNull(embed_version) explicitly.
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
      // A content edit during the provider call invalidates this result even when
      // the row still needs an embedding. Match the selected source null-safely.
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
    // Resolve each KC's effective domain (root-ward walk) so the embed text — and
    // thus the vector + content-hash — disambiguates same-named cross-subject KCs.
    //
    // F2 — resolve in bounded-concurrency chunks (parallel within a chunk,
    // sequential across chunks) instead of one serial walk per row, while keeping
    // each row mapped to its own resolved domain via index alignment.
    const resolved: { k: (typeof ks)[number]; text: string }[] = [];
    for (let start = 0; start < ks.length; start += EFFECTIVE_DOMAIN_CONCURRENCY) {
      const chunk = ks.slice(start, start + EFFECTIVE_DOMAIN_CONCURRENCY);
      const outcomes = await Promise.allSettled(chunk.map((k) => getEffectiveDomain(db, k.id)));
      for (let j = 0; j < chunk.length; j++) {
        const k = chunk[j];
        const outcome = outcomes[j];
        // F1 — a THROWN resolution error is transient/broken-tree: do NOT embed,
        // do NOT stamp version/hash. Skipping leaves the row's prior
        // embedding/version untouched so the SELECT predicate re-picks it on the
        // next backfill (a transient failure must not permanently freeze a row
        // with a degraded — name-only — vector). getEffectiveDomain never returns
        // a null/empty domain; it either yields a real string or throws, so a
        // rejected outcome is the only "can't resolve" case to handle here.
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
          // write guard (see question update above): concurrency-safe fill.
          .where(and(eq(knowledge.id, k.id), kStale));
      }
    }
    // Only rows that resolved a correct effective-domain are embedded + counted;
    // the invariant is that embed_version=EMBED_VERSION is stamped ONLY alongside
    // a correctly-resolved domain (skipped rows stay re-pickable).
    total += resolved.length;
  }

  return total;
}

// pg-boss handler builder (mirrors buildItemPriorBackfillHandler): takes the db
// injected by register-capability-jobs and returns the batch handler. A throw
// propagates to pg-boss for retry (rows stay NULL → next nightly run retries).
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
