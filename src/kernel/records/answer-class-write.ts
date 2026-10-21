// answer_class is derived from a question's structural inputs. Deriving it at
// write time avoids leaving fresh rows NULL until the nightly backfill; rows
// without `kind` stay NULL and are never guessed.
//
// Profile-vocab kinds are normalized in memory for derivation only; the kind
// column is never rewritten.

import type { z } from 'zod';
import { type QuestionKindT, deriveAnswerClass } from '@/core/schema/answer-class';
import type { Rubric } from '@/core/schema/business';
import type { question } from '@/db/schema';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';

type QuestionInsert = typeof question.$inferInsert;

/**
 * Derive answer_class from a question's structural inputs. Dirty profile-vocab
 * kinds are normalized in memory; the kind column is never rewritten. Returns
 * null when `kind` is absent rather than guessing.
 */
export function deriveAnswerClassForValues(values: {
  kind?: string | null;
  choices_md?: string[] | null;
  rubric_json?: z.infer<typeof Rubric> | null;
}): ReturnType<typeof deriveAnswerClass> | null {
  if (values.kind == null || values.kind === '') return null;
  // Unknown kinds fall back to the raw string, matching the nightly backfill.
  const kind = (normalizeToCanonicalKind(values.kind) ?? values.kind) as QuestionKindT;
  return deriveAnswerClass({
    kind,
    choices_md: values.choices_md ?? null,
    rubric_json: values.rubric_json ?? null,
  });
}

/** Add a freshly derived answer_class unless the caller set one explicitly. */
export function withAnswerClass<T extends Partial<QuestionInsert>>(
  values: T,
): T & { answer_class?: string | null } {
  if (values.answer_class != null) return values;
  const derived = deriveAnswerClassForValues({
    kind: values.kind,
    choices_md: values.choices_md,
    rubric_json: values.rubric_json,
  });
  if (derived == null) return values;
  return { ...values, answer_class: derived };
}
