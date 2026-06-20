// YUK-383 Phase 0 — idempotent embed backfill job. One job covers all four
// cases: existing-corpus backfill, next-day new rows, embed-API-failure retry
// (§9 fallback: a question is always inserted with embedding NULL; this nightly
// job fills it), AND (YUK-393) corpus re-embed when EMBED_VERSION bumps.
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

import { getEffectiveDomain } from '@/capabilities/knowledge/server/domain';
import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { EMBED_MODEL, embedMany } from '@/server/ai/embed';
import { embedHash, knowledgeEmbedText, questionEmbedText } from '@/server/ai/embed-source';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import type { Job } from 'pg-boss';

// Bump when the embedder model or the embed-source join rule changes, to trigger
// a background re-embed of rows stamped with an older version. v2 (YUK-393):
// KC embed text now folds effective-domain → every existing KC vector is stale.
const EMBED_VERSION = 2;

/** Idempotent: embed up to `limit` question rows + `limit` knowledge rows whose
 *  embedding IS NULL OR whose embed_version is behind EMBED_VERSION, stamping
 *  model + version + content-hash. Returns the number embedded. */
export async function runEmbedBackfill(db: Db, limit = 100): Promise<number> {
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
    const vecs = await embedMany(texts);
    for (let i = 0; i < qs.length; i++) {
      await db
        .update(question)
        .set({
          embedding: vecs[i],
          embed_model: EMBED_MODEL,
          embed_version: EMBED_VERSION,
          embed_content_hash: embedHash(texts[i]),
        })
        // write guard: only fill rows still matching the stale predicate, so a
        // concurrent worker / pg-boss retry that already re-embedded this row
        // between our SELECT and UPDATE can't be clobbered by a stale vector.
        .where(and(eq(question.id, qs[i].id), qStale));
    }
    total += qs.length;
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
    const texts: string[] = [];
    for (const k of ks) {
      // getEffectiveDomain throws on a broken tree (missing node / root with null
      // domain). One pathological KC must not fail the whole nightly batch, so
      // degrade to the bare `domain` column on a walk error (matches the legacy
      // pre-YUK-393 embed text) rather than aborting every other row's re-embed.
      let effectiveDomain: string | null = null;
      try {
        effectiveDomain = await getEffectiveDomain(db, k.id);
      } catch {
        effectiveDomain = k.domain;
      }
      texts.push(knowledgeEmbedText({ name: k.name, effectiveDomain }));
    }
    const vecs = await embedMany(texts);
    for (let i = 0; i < ks.length; i++) {
      await db
        .update(knowledge)
        .set({
          embedding: vecs[i],
          embed_model: EMBED_MODEL,
          embed_version: EMBED_VERSION,
          embed_content_hash: embedHash(texts[i]),
        })
        // write guard (see question update above): concurrency-safe fill.
        .where(and(eq(knowledge.id, ks[i].id), kStale));
    }
    total += ks.length;
  }

  return total;
}

// pg-boss handler builder (mirrors buildItemPriorBackfillHandler): takes the db
// injected by register-capability-jobs and returns the batch handler. A throw
// propagates to pg-boss for retry (rows stay NULL → next nightly run retries).
export function buildEmbedBackfillHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const embedded = await runEmbedBackfill(db);
      console.log('[embed_backfill] embedded', embedded);
    } catch (err) {
      console.error('[embed_backfill] failed', err);
      throw err;
    }
  };
}
