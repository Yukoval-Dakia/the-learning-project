// Pure structural answer-class classifier (kind reshape Step 3, YUK-390).
//
// `answer_class` is the 4-value VERIFICATION axis {exact, keyword, semantic,
// steps} — a coarse "how is this answer checked" tag. It is DISTINCT from
// `judge_kind_override` (the 8-value dispatch ROUTE override that
// route-resolve.ts returns first), which this module does NOT touch: the kind
// reshape materializes answer_class into its own question.answer_class column
// (backfill + on-write) for retrieval filtering + the kind two-axis reshape,
// leaving judge routing (and its profile-aware unit_dimension / multimodal_direct
// routes) byte-for-byte unchanged (A5-safe by construction).
//
// Pure: no SubjectProfile, no IO. The choices-first short-circuit mirrors
// route-resolve.ts:130-131 — a question with persisted choices is exact
// regardless of the kind string a subject profile uses. `derivation → steps`
// here is the verification CLASS (the generation dispatch collapses derivation
// to semantic in judge-routing.ts; that is a separate concern, not this column).
import type { z } from 'zod';
import type { QuestionKind, Rubric } from './business';
import { nonEmptyStrings } from './judge-routing';

export type QuestionKindT = z.infer<typeof QuestionKind>;

export const ANSWER_CLASSES = ['exact', 'keyword', 'semantic', 'steps'] as const;
export type AnswerClass = (typeof ANSWER_CLASSES)[number];

/** Minimum structural shape needed to classify a question's answer-class. */
export interface AnswerClassInput {
  kind: QuestionKindT;
  rubric_json?: z.infer<typeof Rubric> | null;
  choices_md?: string[] | null;
}

/**
 * Derive the 4-value answer-class from question structure. Choices-first; then
 * kind-based with keyword-sensitivity for fill_blank / computation. All 9
 * QuestionKind values are covered (prose + any fallthrough → semantic).
 */
export function deriveAnswerClass(q: AnswerClassInput): AnswerClass {
  if ((q.choices_md ?? []).length > 0) return 'exact';
  if (q.kind === 'choice' || q.kind === 'true_false') return 'exact';
  if (q.kind === 'fill_blank') {
    return nonEmptyStrings(q.rubric_json?.keywords).length > 0 ? 'keyword' : 'exact';
  }
  if (q.kind === 'computation') {
    return nonEmptyStrings(q.rubric_json?.keywords).length > 0 ? 'keyword' : 'semantic';
  }
  if (q.kind === 'derivation') return 'steps';
  // prose (short_answer / reading / translation / essay) + any other → semantic
  return 'semantic';
}
