// YUK-383 Phase 0 — idempotent embed backfill job. One job covers all three
// cases: existing-corpus backfill, next-day new rows, and embed-API-failure retry
// (§9 fallback: a question is always inserted with embedding NULL; this nightly
// job fills it). Idempotent because it only touches rows where embedding IS NULL —
// a second run with no NULL rows is a no-op. embed_version stamps which join rule
// / model produced the vector; bump EMBED_VERSION to trigger a background re-embed
// (clear embedding for stale versions in a future migration). embedMany throwing
// (API down) fails the job and leaves rows NULL → pg-boss retries next run; the
// question-insert path never calls this job, so ingestion is unaffected.
//
// SCOPE — NULL-backfill only; re-embed-on-edit is DEFERRED (PR #439 review).
// This job intentionally selects ONLY `embedding IS NULL` rows. It does NOT
// re-embed when source text/context changes after the fact — e.g. editQuestion
// (src/server/questions/write.ts) rewriting prompt_md/reference_md/choices_md, or
// applyReparent (src/capabilities/knowledge/server/proposals.ts) nulling a moved
// root's domain (which shifts knowledgeEmbedText / effective-domain context).
// After such edits the stored vector is STALE until a manual re-embed.
// Refreshing on content edit is the deferred "embed-on-write" capability: it
// needs a content-hash/version column + a migration (and the embed-source join
// would gain effective-domain context for child KCs), which collides with this
// PR's migration numbering. Tracked as a follow-up — do not bolt it on here.

import type { Db } from '@/db/client';
import { knowledge, question } from '@/db/schema';
import { EMBED_MODEL, embedMany } from '@/server/ai/embed';
import { knowledgeEmbedText, questionEmbedText } from '@/server/ai/embed-source';
import { and, eq, isNull } from 'drizzle-orm';
import type { Job } from 'pg-boss';

// Bump when the embedder model or the embed-source join rule changes, to trigger
// a background re-embed of rows stamped with an older version.
const EMBED_VERSION = 1;

/** Idempotent: embed up to `limit` question rows + `limit` knowledge rows whose
 *  embedding IS NULL, stamping model + version. Returns the number embedded. */
export async function runEmbedBackfill(db: Db, limit = 100): Promise<number> {
  let total = 0;

  const qs = await db.select().from(question).where(isNull(question.embedding)).limit(limit);
  if (qs.length > 0) {
    const vecs = await embedMany(qs.map((q) => questionEmbedText(q)));
    for (let i = 0; i < qs.length; i++) {
      await db
        .update(question)
        .set({ embedding: vecs[i], embed_model: EMBED_MODEL, embed_version: EMBED_VERSION })
        // isNull write guard: only fill rows still NULL, so a concurrent worker /
        // pg-boss retry that already embedded this row between our SELECT and
        // UPDATE can't be clobbered by a stale vector.
        .where(and(eq(question.id, qs[i].id), isNull(question.embedding)));
    }
    total += qs.length;
  }

  const ks = await db.select().from(knowledge).where(isNull(knowledge.embedding)).limit(limit);
  if (ks.length > 0) {
    const vecs = await embedMany(ks.map((k) => knowledgeEmbedText(k)));
    for (let i = 0; i < ks.length; i++) {
      await db
        .update(knowledge)
        .set({ embedding: vecs[i], embed_model: EMBED_MODEL, embed_version: EMBED_VERSION })
        // isNull write guard (see question update above): concurrency-safe fill.
        .where(and(eq(knowledge.id, ks[i].id), isNull(knowledge.embedding)));
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
