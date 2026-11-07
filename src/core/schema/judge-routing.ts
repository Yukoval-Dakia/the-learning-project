// Shared judge-route inference for AI-generated questions.
//
// EmbeddedCheckGenerate and QuizGen need the same default judge_kind for a freshly
// generated question, so the routing rule lives here in core/ (cross-subject, no IO)
// instead of being duplicated per handler.
//
// The input is structural (kind + optional override + optional rubric) so any
// generated-question shape carrying those fields can be routed without importing the
// per-handler Zod schema.
//
// The default route is a pure read of the answer-class axis
// (core/schema/answer-class.ts, the single source of truth). This is the profile-free
// generation twin of resolveQuestionJudgeRoute; keep the two behavior-synced.
// Answer text interpretation and comparison live in
// core/schema/assessment/answer-compare.ts — this module only routes.
import type { z } from 'zod';
import { deriveAnswerClass } from './answer-class';
import type { JudgeKind, QuestionKind, Rubric } from './business';

// question.kind is a free-form display label; QuestionKindT is
// `string` (kept as an alias for source-compatible imports). No reader below
// treats the label as a closed-set authority.
export type QuestionKindT = z.infer<typeof QuestionKind>;
export type JudgeKindT = z.infer<typeof JudgeKind>;

// nonEmptyStrings moved to answer-class.ts so judge-routing can import
// deriveAnswerClass without an import cycle; re-exported here to keep this
// module's public surface stable for its existing consumers.
export { nonEmptyStrings } from './answer-class';

/** Minimum shape needed to infer a default judge route for a generated question. */
export interface JudgeRoutableQuestion {
  kind: QuestionKindT;
  judge_kind_override?: JudgeKindT | null;
  rubric_json?: z.infer<typeof Rubric> | null;
}

export function defaultJudgeKindForQuestion(q: JudgeRoutableQuestion): JudgeKindT {
  if (q.judge_kind_override) return q.judge_kind_override;
  // The gen-time twin is choices-blind by contract (generated choice rows carry
  // choices_md, but the runtime resolver owns the choices→exact structural
  // priority; parity is pinned cell-for-cell in answer-class-route-parity.test.ts).
  switch (
    deriveAnswerClass({ kind: q.kind, rubric_json: q.rubric_json ?? null, choices_md: null })
  ) {
    case 'exact':
      return 'exact';
    case 'keyword':
      return 'keyword';
    // derivation must NEVER fall through to exact — step-by-step
    // answers cannot be graded by string equality. Generated derivation runs through
    // semantic (required_points-driven); the 'steps' route is reserved for
    // first-class math questions with reference_solution shape (see
    // src/core/capability/judges/steps.ts), not generator output. Defense-in-depth
    // covers LLM hallucination + future prompt changes.
    case 'steps':
      return 'semantic';
    case 'semantic':
      // Prose + keyword-less computation + every free-form label →
      // semantic. The retired closed-enum fallback sent non-enum kinds to
      // 'exact'; under free-form labels that cell is removed — 'semantic' is
      // the conservative model-backed default for any label the classifier
      // does not recognise.
      return 'semantic';
  }
}
