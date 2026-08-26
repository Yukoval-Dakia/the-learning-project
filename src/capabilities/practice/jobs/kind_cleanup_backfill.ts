// YUK-390 kind Step 3 residual (PR B) — idempotent persisted-kind cleanup.
//
// Historically, seed / fixture write paths (subjects/{math,physics,yuwen}
// fixtures) leaked the profile/skill vocabulary (SubjectQuestionKind:
// 'single_choice' / 'calculation' / 'reading_comprehension' ...) directly into
// the persisted `question.kind` column, which the canonical vocabulary
// (core/schema/business.ts QuestionKind) declares as落库真值. The answer_class
// backfill normalizes IN-MEMORY for derivation only; this job finishes the
// residual: it REWRITES persisted dirty kinds to canonical so the column
// converges on one vocabulary.
//
// Reuses normalizeToCanonicalKind (subjects/question-kind.ts) — the SAME
// single-authority normalizer the answer_class backfill uses in-memory; no
// second mapping is introduced here. Fail-closed on neither-vocab values:
// they are counted + logged, never silently rewritten (the caller keeps the
// NULL-route fallback semantics of normalizeToCanonicalKind === null).
//
// Idempotent: the SELECT only matches rows whose kind is outside the canonical
// vocabulary, so a second run with nothing dirty is a no-op. No DDL / no
// migration number consumed (pure data backfill, per the repo backfill
// pattern). answer_class need not be re-derived after this rewrite:
// deriveAnswerClass normalizes first, so its output is invariant under
// kind canonicalization. The insertion seams (subject fixture schemas) are
// tightened in the same change, so no new dirty rows can enter via fixtures.

import { and, eq, notInArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import { QuestionKind } from '@/core/schema/business';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';

export interface KindCleanupResult {
  /** Rows rewritten from a dirty profile-vocab kind to its canonical kind. */
  cleaned: number;
  /** Rows whose kind is in NEITHER vocabulary — skipped (fail-closed), logged. */
  unknown: number;
}

/** Idempotent: canonicalize up to `limit` dirty-kind question rows. */
export async function runKindCleanupBackfill(db: Db, limit = 500): Promise<KindCleanupResult> {
  // Only dirty rows: kind outside the canonical vocabulary. QuestionKind.options
  // is the runtime canonical list (single source — no hand-rolled second copy).
  const rows = await db
    .select({ id: question.id, kind: question.kind })
    .from(question)
    .where(notInArray(question.kind, QuestionKind.options))
    .limit(limit);

  let cleaned = 0;
  let unknown = 0;
  for (const r of rows) {
    const canonical = normalizeToCanonicalKind(r.kind);
    if (canonical === null) {
      // Neither-vocab value: record it, never guess (fail-closed).
      unknown += 1;
      continue;
    }
    await db
      .update(question)
      .set({ kind: canonical })
      // write guard: never clobber a row whose kind changed between our SELECT
      // and UPDATE (mirrors answer_class_backfill's isNull write guard).
      .where(and(eq(question.id, r.id), eq(question.kind, r.kind)));
    cleaned += 1;
  }
  return { cleaned, unknown };
}

// pg-boss handler builder (mirrors buildAnswerClassBackfillHandler). A throw
// propagates to pg-boss for retry; dirty rows remain dirty → next run retries.
export function buildKindCleanupBackfillHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const res = await runKindCleanupBackfill(db);
      console.log('[kind_cleanup_backfill] cleaned', res.cleaned, 'unknown', res.unknown);
    } catch (err) {
      console.error('[kind_cleanup_backfill] failed', err);
      throw err;
    }
  };
}
