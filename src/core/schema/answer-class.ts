// Pure structural answer-class classifier (kind reshape Step 3, YUK-390;
// kind-family convergence Step 4, YUK-391).
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
// YUK-391: this module is the SINGLE SOURCE OF TRUTH for the exact/keyword vs
// semantic/steps distinction. The five former per-kind judge-routing mirrors
// (route-resolve.ts if-chain, judge-routing.ts gen-time twin, verify-framework
// EXACT_KINDS, target-discovery OBJECTIVE_KINDS, the PROSE_KINDS consumers, and
// the QUIZ_PLAN_OBJECTIVE_KINDS plan set) all derive from the predicates below
// instead of hand-maintained kind sets. Route parity is pinned by
// answer-class-route-parity.test.ts.
//
// Pure: no SubjectProfile, no IO. The choices-first short-circuit mirrors
// route-resolve.ts:130-131 — a question with persisted choices is exact
// regardless of the kind string a subject profile uses. `derivation → steps`
// here is the verification CLASS (the generation dispatch collapses derivation
// to semantic in judge-routing.ts; that is a separate concern, not this column).
import type { z } from 'zod';
import { QuestionKind, type Rubric } from './business';

export type QuestionKindT = z.infer<typeof QuestionKind>;

export const ANSWER_CLASSES = ['exact', 'keyword', 'semantic', 'steps'] as const;
export type AnswerClass = (typeof ANSWER_CLASSES)[number];

/** Deterministic (客观) answer classes — verifiable by local string comparison. */
export const OBJECTIVE_ANSWER_CLASSES: ReadonlySet<AnswerClass> = new Set(['exact', 'keyword']);

/** Model-backed answer classes — the verdict comes from an LLM judge. */
export const LLM_ANSWER_CLASSES: ReadonlySet<AnswerClass> = new Set(['semantic', 'steps']);

/** True iff the class is verifiable by local string comparison (exact/keyword). */
export function isObjectiveAnswerClass(cls: AnswerClass): boolean {
  return OBJECTIVE_ANSWER_CLASSES.has(cls);
}

/** True iff the class needs a model-backed judge (semantic/steps). */
export function isLlmAnswerClass(cls: AnswerClass): boolean {
  return LLM_ANSWER_CLASSES.has(cls);
}

/** Trim and drop blank entries; undefined → []. */
export function nonEmptyStrings(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

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

// ── kind-level families (YUK-391) ─────────────────────────────────────────────
//
// deriveAnswerClass classifies a ROW (kind × choices × rubric). The retired
// judge-routing mirrors classified a KIND ALONE. The kind-level families below
// derive from deriveAnswerClass by varying the KEYWORD dimension — the only
// rubric input that can move the class — so a kind joins a family exactly when
// every keyword shape of that kind lands on that family's side. Choice
// presence is NOT part of the kind dimension: choices force 'exact' for any
// kind, so every site that has the row applies its own choices-first check
// (mirroring deriveAnswerClass's own structural priority).

// The two keyword shapes a kind can be classified under (a valid Rubric with
// one non-blank keyword, and no rubric at all).
const RUBRIC_WITH_KEYWORD: z.infer<typeof Rubric> = { criteria: [], keywords: ['anchor'] };

function classifyKind(kind: string, rubric: z.infer<typeof Rubric> | null): AnswerClass {
  return deriveAnswerClass({ kind: kind as QuestionKindT, rubric_json: rubric, choices_md: null });
}

/**
 * Kinds whose answer-class is objective (exact/keyword) under EVERY keyword
 * shape → {choice, true_false, fill_blank}. Replaces the hand-maintained
 * EXACT_KINDS / OBJECTIVE_KINDS / QUIZ_PLAN_OBJECTIVE_KINDS sets. Raw strings
 * are classified as-is (NO profile-vocab normalization — unknown kinds derive
 * semantic, matching the retired sets' raw-string `.has` behavior).
 */
export function isObjectiveAnswerKind(kind: string): boolean {
  return (
    OBJECTIVE_ANSWER_CLASSES.has(classifyKind(kind, null)) &&
    OBJECTIVE_ANSWER_CLASSES.has(classifyKind(kind, RUBRIC_WITH_KEYWORD))
  );
}

/**
 * Kinds whose answer-class is model-backed (semantic/steps) under EVERY keyword
 * shape → prose ∪ {derivation}. Replaces the PROSE_KINDS ∪ {derivation}
 * membership checks (quiz_gen's "cannot use exact judge" guard). Raw unknown
 * strings derive semantic → true, so callers gate on zod-validated kinds.
 */
export function isLlmGradedAnswerKind(kind: string): boolean {
  return (
    LLM_ANSWER_CLASSES.has(classifyKind(kind, null)) &&
    LLM_ANSWER_CLASSES.has(classifyKind(kind, RUBRIC_WITH_KEYWORD))
  );
}

/**
 * The unique canonical kind in NEITHER kind-level family: its class flips
 * keyword↔semantic across the keyword dimension (keyword with rubric keywords,
 * semantic without) → exactly 'computation'. Its semantic side is an ESCAPE
 * from keyword matching, so routing treats it unconditionally (never through
 * the prose ladder / multimodal gate) — see route-resolve.ts.
 */
export function isKeywordConditionalAnswerKind(kind: string): boolean {
  return !isObjectiveAnswerKind(kind) && !isLlmGradedAnswerKind(kind);
}

/**
 * The objective kind family as a Set (derived, not hand-maintained):
 * {choice, true_false, fill_blank}. Single source for the converged
 * OBJECTIVE_KINDS / QUIZ_PLAN_OBJECTIVE_KINDS exports.
 */
export const OBJECTIVE_ANSWER_KINDS: ReadonlySet<string> = new Set(
  QuestionKind.options.filter((kind) => isObjectiveAnswerKind(kind)),
);
