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
import { KNOWN_QUESTION_KIND_IDS, type QuestionKind, type Rubric } from './business';

// YUK-386 — question.kind is now a free-form display label (z.string().min(1)),
// so QuestionKindT is just `string`. The alias is kept so existing imports stay
// source-compatible; the label is NEVER a behavioural authority — the kind
// string below is only a coarse hint deriveAnswerClass reads AFTER structure.
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
  // Free-form kind label (YUK-386). Only the KNOWN labels steer the class; an
  // unknown label falls through to 'semantic' (the conservative default).
  kind: string;
  rubric_json?: z.infer<typeof Rubric> | null;
  choices_md?: string[] | null;
}

/**
 * Derive the 4-value answer-class from question structure. Choices-first; then
 * kind-label hints with keyword-sensitivity for fill_blank / computation. The
 * known labels are covered explicitly; any other (free-form) label → semantic.
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
  return deriveAnswerClass({ kind, rubric_json: rubric, choices_md: null });
}

/**
 * The answer class a bare kind LABEL implies — kind-only, no row structure
 * (choices/rubric deliberately excluded). This is the right level for
 * comparing a requested kind label against a produced one: both sides are
 * labels, so both must be classified without row structure (a 'fill_blank'
 * label implies 'exact' even though a fill_blank ROW with rubric keywords
 * classifies 'keyword').
 */
export function answerClassForKindLabel(kind: string): AnswerClass {
  return classifyKind(kind, null);
}

/**
 * True iff two kind labels imply the same answer class — the YUK-386 pin /
 * conformance comparator. Kind names never enter a branch directly; two labels
 * conform exactly when they imply the same verification class ('choice' ≡
 * 'fill_blank' ≡ 'true_false' → exact; prose labels → semantic; 'derivation' →
 * steps). For profile-vocabulary folding on top of this, see
 * subjects/question-kind.ts answerClassCompatible.
 */
export function kindLabelsShareAnswerClass(a: string, b: string): boolean {
  return answerClassForKindLabel(a) === answerClassForKindLabel(b);
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
 * OBJECTIVE_KINDS / QUIZ_PLAN_OBJECTIVE_KINDS exports. YUK-386: derived from
 * the KNOWN label vocabulary (business.ts KNOWN_QUESTION_KIND_IDS) — a lookup
 * over familiar labels, not a closed-set gate on persisted kind.
 */
export const OBJECTIVE_ANSWER_KINDS: ReadonlySet<string> = new Set(
  KNOWN_QUESTION_KIND_IDS.filter((kind) => isObjectiveAnswerKind(kind)),
);
