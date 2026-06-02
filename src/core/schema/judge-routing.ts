// Shared judge-route inference for AI-generated questions.
//
// Extracted from src/server/boss/handlers/embedded_check_generate.ts (Q1 of the
// search-grounded QuizGen wave, docs/superpowers/specs/2026-06-02-quizgen-search-grounded-design.md
// §2 / §5). Both EmbeddedCheckGenerate and QuizGen (and any future generator)
// need the same default judge_kind for a freshly generated question, so the
// routing rule lives here in core/ (cross-subject, no IO) rather than being
// duplicated per handler.
//
// The input is structural (kind + optional override + optional rubric) so any
// generated-question shape that carries those fields can be routed without
// importing the per-handler Zod schema.
import type { z } from 'zod';
import type { JudgeKind, QuestionKind, Rubric } from './business';

export type QuestionKindT = z.infer<typeof QuestionKind>;
export type JudgeKindT = z.infer<typeof JudgeKind>;

/** Minimum shape needed to infer a default judge route for a generated question. */
export interface JudgeRoutableQuestion {
  kind: QuestionKindT;
  judge_kind_override?: JudgeKindT | null;
  rubric_json?: z.infer<typeof Rubric> | null;
}

// Prose / open-ended kinds cannot be graded by string equality — they route to
// the semantic judge (required_points-driven). Kept as an exported Set so the
// judge-contract assertions in handlers can share the membership check.
export const PROSE_KINDS = new Set<QuestionKindT>([
  'short_answer',
  'reading',
  'translation',
  'essay',
]);

/** Trim and drop blank entries; undefined → []. */
export function nonEmptyStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

export function defaultJudgeKindForQuestion(q: JudgeRoutableQuestion): JudgeKindT {
  if (q.judge_kind_override) return q.judge_kind_override;
  if (q.kind === 'choice' || q.kind === 'true_false') return 'exact';
  if (q.kind === 'fill_blank') {
    return nonEmptyStrings(q.rubric_json?.keywords).length > 0 ? 'keyword' : 'exact';
  }
  if (q.kind === 'computation') {
    return nonEmptyStrings(q.rubric_json?.keywords).length > 0 ? 'keyword' : 'semantic';
  }
  // M2.1 (2026-05-22): derivation must NEVER fall through to exact — step-by-step
  // answers cannot be graded by string equality. Generated derivation runs through
  // semantic (required_points-driven); the 'steps' route is reserved for
  // first-class math questions with reference_solution shape (see
  // src/core/capability/judges/steps.ts), not generator output. Defense-in-depth
  // covers LLM hallucination + future prompt changes.
  if (q.kind === 'derivation') return 'semantic';
  return PROSE_KINDS.has(q.kind) ? 'semantic' : 'exact';
}
