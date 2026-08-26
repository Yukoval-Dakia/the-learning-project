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
//
// YUK-391 (kind Step 4) — the default route is a pure read of the answer-class
// axis (core/schema/answer-class.ts, the single source of truth). This is the
// PROFILE-FREE generation twin of route-resolve.ts
// (resolveQuestionJudgeRoute); the two must stay behavior-synced — pinned by
// src/core/schema/answer-class-route-parity.test.ts.
import type { z } from 'zod';
import { deriveAnswerClass } from './answer-class';
import { type JudgeKind, QuestionKind, type Rubric } from './business';

export type QuestionKindT = z.infer<typeof QuestionKind>;
export type JudgeKindT = z.infer<typeof JudgeKind>;

// nonEmptyStrings moved to answer-class.ts (YUK-391) so judge-routing can import
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
    // M2.1 (2026-05-22): derivation must NEVER fall through to exact — step-by-step
    // answers cannot be graded by string equality. Generated derivation runs through
    // semantic (required_points-driven); the 'steps' route is reserved for
    // first-class math questions with reference_solution shape (see
    // src/core/capability/judges/steps.ts), not generator output. Defense-in-depth
    // covers LLM hallucination + future prompt changes.
    case 'steps':
      return 'semantic';
    case 'semantic':
      // Canonical semantic kinds (prose + keyword-less computation) → semantic.
      // A NON-enum kind string derives class 'semantic' but the hand-rolled chain
      // this replaced fell it through to 'exact' (PROSE fallthrough); keep that
      // legacy cell byte-identical rather than silently rerouting dirty data.
      return QuestionKind.safeParse(q.kind).success ? 'semantic' : 'exact';
  }
}
