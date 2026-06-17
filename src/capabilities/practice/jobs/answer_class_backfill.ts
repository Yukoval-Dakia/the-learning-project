// YUK-390 kind Step 3 — idempotent answer_class backfill. Materializes the
// answer-class verification tag (deriveAnswerClass) into question.answer_class
// for rows where it IS NULL. Pure derivation (no API call), unlike embed_backfill.
// Idempotent: only touches answer_class IS NULL rows; a second run with none left
// is a no-op.
//
// Dirty-kind handling (read-side only): question.kind has leaked profile-vocab
// values (e.g. 'single_choice'/'calculation', see question-kind.ts:120-126). We
// normalize to canonical IN-MEMORY via normalizeToCanonicalKind purely to derive
// the right answer_class — this job does NOT rewrite the kind column (that cleanup
// is Step 3 PR B). choices-first in deriveAnswerClass means choice-typed dirty
// rows classify correctly regardless; unknown kinds fall through to semantic.
//
// SCOPE — NULL-backfill only. answer_class is DERIVED from kind/choices_md/
// rubric_json; an editQuestion that rewrites those leaves answer_class stale until
// re-derived. on-write@insert (the 12 insert(question) sites) + re-derive@edit are
// a deferred follow-up — deriveAnswerClass is pure+cheap, so a future insert-site
// hook / trigger / re-derive pass can keep it fresh trivially. Do not bolt on here.

import { type QuestionKindT, deriveAnswerClass } from '@/core/schema/answer-class';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';
import { and, eq, isNull } from 'drizzle-orm';
import type { Job } from 'pg-boss';

/** Idempotent: classify up to `limit` question rows whose answer_class IS NULL.
 *  Returns the number classified. */
export async function runAnswerClassBackfill(db: Db, limit = 500): Promise<number> {
  const rows = await db
    .select({
      id: question.id,
      kind: question.kind,
      choices_md: question.choices_md,
      rubric_json: question.rubric_json,
    })
    .from(question)
    .where(isNull(question.answer_class))
    .limit(limit);

  for (const r of rows) {
    // normalize dirty profile-vocab kind → canonical for derivation only (no kind write)
    const kind = (normalizeToCanonicalKind(r.kind) ?? r.kind) as QuestionKindT;
    const answer_class = deriveAnswerClass({
      kind,
      choices_md: r.choices_md,
      rubric_json: r.rubric_json,
    });
    await db
      .update(question)
      .set({ answer_class })
      // isNull write guard: only fill rows still NULL, so a concurrent run can't be
      // clobbered between our SELECT and UPDATE.
      .where(and(eq(question.id, r.id), isNull(question.answer_class)));
  }
  return rows.length;
}

// pg-boss handler builder (mirrors buildEmbedBackfillHandler). A throw propagates
// to pg-boss for retry; rows stay NULL → next nightly run retries.
export function buildAnswerClassBackfillHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const n = await runAnswerClassBackfill(db);
      console.log('[answer_class_backfill] classified', n);
    } catch (err) {
      console.error('[answer_class_backfill] failed', err);
      throw err;
    }
  };
}
