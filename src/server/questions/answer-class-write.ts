// YUK-395 (P2 A3) — answer_class ON-WRITE freshness.
//
// `answer_class` is the 4-value VERIFICATION axis {exact, keyword, semantic,
// steps} derived structurally from kind/choices_md/rubric_json by the pure
// `deriveAnswerClass` (core/schema/answer-class.ts). Until this util, the column
// was filled ONLY by the nightly `answer_class_backfill` job (NULL-only,
// idempotent), so every freshly-inserted question stayed answer_class=NULL for up
// to a day — hard-blocking any reader that treats answer_class as authoritative
// (the future B4 matcher hard-filter; currently NOT wired — matcher.ts:66 accepts
// answerClass but never puts it in the WHERE clause).
//
// This util closes the freshness gap by deriving answer_class AT WRITE TIME:
//   - every `insert(question)` site wraps its values with `withAnswerClass(...)`;
//   - editQuestion re-derives via `deriveAnswerClassForValues(...)` when an edit
//     changes kind / choices_md / rubric_json (otherwise the old value goes stale).
//
// Behavior-neutral by construction: deriveAnswerClass is pure+cheap (no IO), and
// no live reader branches on answer_class NULL-vs-set today. The nightly backfill
// remains the catch-up safety net for any row this misses (e.g. a structurally
// incomplete row deliberately left NULL).
//
// Kind normalization mirrors the backfill (answer_class_backfill.ts:42-43):
// question.kind has leaked profile-vocab values (single_choice / calculation /
// reading_comprehension …, see question-kind.ts), so we normalize to canonical
// IN-MEMORY purely to derive the right answer_class — we never rewrite the kind
// column here. This guarantees on-write and backfill produce identical results.

import { type QuestionKindT, deriveAnswerClass } from '@/core/schema/answer-class';
import type { Rubric } from '@/core/schema/business';
import type { question } from '@/db/schema';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';
import type { z } from 'zod';

type QuestionInsert = typeof question.$inferInsert;

/**
 * Derive answer_class from a question's structural inputs (kind/choices_md/
 * rubric_json), normalizing dirty profile-vocab kinds to canonical first (no kind
 * rewrite — derivation only). Returns the AnswerClass, or `null` when the row
 * genuinely lacks the structural input we classify on (no `kind`) — those stay
 * NULL and the nightly backfill / read-time derive remains the safety net. We
 * NEVER guess.
 */
export function deriveAnswerClassForValues(values: {
  kind?: string | null;
  choices_md?: string[] | null;
  rubric_json?: z.infer<typeof Rubric> | null;
}): ReturnType<typeof deriveAnswerClass> | null {
  // No kind → genuinely lacks the structural input; leave NULL (never guess).
  if (values.kind == null || values.kind === '') return null;
  // Normalize profile-vocab → canonical for derivation; unknown kinds fall back
  // to the raw string so deriveAnswerClass's `prose/other → semantic` covers them
  // (identical to answer_class_backfill.ts:43).
  const kind = (normalizeToCanonicalKind(values.kind) ?? values.kind) as QuestionKindT;
  return deriveAnswerClass({
    kind,
    choices_md: values.choices_md ?? null,
    rubric_json: values.rubric_json ?? null,
  });
}

/**
 * Wrap a question INSERT values object with a freshly-derived `answer_class`.
 * Drop-in for every question-insert site — wrap the values object passed to the
 * Drizzle `.values(...)` call: `.values(withAnswerClass({ id, kind, ... }))`.
 *
 * If the caller already set an explicit answer_class it is preserved (the caller
 * wins). If the row lacks the structural input (`kind`), answer_class is left as
 * whatever the caller passed (typically unset → NULL), never guessed.
 */
export function withAnswerClass<T extends Partial<QuestionInsert>>(
  values: T,
): T & { answer_class?: string | null } {
  // Respect an explicit answer_class the caller already chose.
  if (values.answer_class != null) return values;
  const derived = deriveAnswerClassForValues({
    kind: values.kind,
    choices_md: values.choices_md,
    rubric_json: values.rubric_json,
  });
  if (derived == null) return values;
  return { ...values, answer_class: derived };
}
