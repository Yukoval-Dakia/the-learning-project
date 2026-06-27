// Discriminated attempt-payload sub-schema (YUK-367 / A1).
//
// owner ratify 2026-06-16 — docs/superpowers/plans/2026-06-16-A1-A5-ratified-decisions.md.
//
// WHAT THIS IS: a per-archetype discriminated union for the STRUCTURED answer an
// attempt carries, so a deterministic verifier (A5 / YUK-350) and item calibration
// (B1 / YUK-348) can consume structured evidence instead of bare text. Objective
// archetypes (single-/multi-select option, boolean, blank strings, numeric value)
// are first-class; open / prose answers stay free-text.
//
// WHAT THIS IS NOT (owner decisions, see issue body + grounded comment):
//   - NO new table (UTR), NO top-level `question.expected_evidence` column.
//   - This module is the EVIDENCE CARRIER only. It does NOT estimate anything.
//     n=1 litmus: every field below is THIS learner's own answer state (option
//     text / boolean / blank strings / number+unit) — zero cross-subject
//     parameters (a / slip / guess / φ). Admissible. The red line lives downstream:
//     B1 (YUK-348) must NOT group-fit slip/guess off these payloads.
//   - It does NOT decide right/wrong. The deterministic verifier reading this to
//     flip an outcome is A5 / YUK-350 scope (that is where any flag/dark-ship lives);
//     judging today still reads the flat `answer_md`, so landing this schema is a
//     non-behavioral additive change (θ̂ / selection / p(L) byte-identical).
//
// DISCRIMINANT NOTE: the union's `kind` discriminant is the PAYLOAD ARCHETYPE, not
// the `QuestionKind`. The two are deliberately decoupled — the objective/subjective
// split in code is by JUDGE ROUTE (exact/keyword vs semantic), and `computation`
// routes keyword OR semantic depending on its rubric (see
// `defaultJudgeKindForQuestion` in ./judge-routing). So a QuestionKind maps to an
// archetype via ATTEMPT_PAYLOAD_KIND_BY_QUESTION_KIND below, NOT 1:1.
//
// Follows the existing `z.discriminatedUnion('kind', …)` idiom (note-patch.ts,
// event/blocks.ts MaterialRef) and the JudgeResultV2 discriminated-union precedent
// (capability.ts).
import { z } from 'zod';
import type { QuestionKind } from './business';

type QuestionKindT = z.infer<typeof QuestionKind>;

// ── Objective archetypes (first-class structured carriers) ──────────────────

// `choice` — single- or multi-select option answer.
//
// OWNER OPEN QUESTION #3 (option identity): `question.choices_md` is a bare
// jsonb `string[]` (src/db/schema.ts) with NO stable per-option id. Until a
// canonical option id exists, `selected` carries the chosen option *value*
// (option text, or a caller-chosen stable token) — NOT an index (index drifts
// under re-ordering). Adding stable option ids touches the question schema +
// ingestion side and is an independent prerequisite the owner must rule on; this
// module does NOT introduce it. min(1): a recorded choice attempt selected ≥ 1
// option (an empty selection is "left blank", which is not a choice payload).
export const ChoiceAttemptPayload = z.object({
  kind: z.literal('choice'),
  selected: z.array(z.string().min(1)).min(1),
});
export type ChoiceAttemptPayloadT = z.infer<typeof ChoiceAttemptPayload>;

// `true_false` — boolean judgment. Explicit boolean (X-algorithm VALIDATES note,
// 2026-06-26: objective payloads prefer an explicit value over null).
export const TrueFalseAttemptPayload = z.object({
  kind: z.literal('true_false'),
  value: z.boolean(),
});
export type TrueFalseAttemptPayloadT = z.infer<typeof TrueFalseAttemptPayload>;

// `fill_blank` — one string per blank, in document order. An empty string means
// that blank was left empty (explicit value over null); min(1) blanks because a
// fill_blank question has at least one blank.
export const FillBlankAttemptPayload = z.object({
  kind: z.literal('fill_blank'),
  blanks: z.array(z.string()).min(1),
});
export type FillBlankAttemptPayloadT = z.infer<typeof FillBlankAttemptPayload>;

// `numeric` — a number with an optional unit (number+unit objective carrier from
// the issue body). Present in the union as a ready archetype, but NO QuestionKind
// maps to it by default yet: there is no `numeric` QuestionKind, and `computation`
// (the natural home) routes keyword|semantic and is deferred to free_text — see
// OWNER OPEN QUESTION #2 in ATTEMPT_PAYLOAD_KIND_BY_QUESTION_KIND.
export const NumericAttemptPayload = z.object({
  kind: z.literal('numeric'),
  value: z.number(),
  unit: z.string().min(1).optional(),
});
export type NumericAttemptPayloadT = z.infer<typeof NumericAttemptPayload>;

// ── Open / fallback archetype ───────────────────────────────────────────────

// `free_text` — open / prose answers and every kind without a deterministic
// objective carrier. Mirrors today's flat `answer_md` text payload.
export const FreeTextAttemptPayload = z.object({
  kind: z.literal('free_text'),
  text: z.string(),
});
export type FreeTextAttemptPayloadT = z.infer<typeof FreeTextAttemptPayload>;

// ── The union ───────────────────────────────────────────────────────────────

export const AttemptPayload = z.discriminatedUnion('kind', [
  ChoiceAttemptPayload,
  TrueFalseAttemptPayload,
  FillBlankAttemptPayload,
  NumericAttemptPayload,
  FreeTextAttemptPayload,
]);
export type AttemptPayloadT = z.infer<typeof AttemptPayload>;

export const AttemptPayloadKind = z.enum([
  'choice',
  'true_false',
  'fill_blank',
  'numeric',
  'free_text',
]);
export type AttemptPayloadKindT = z.infer<typeof AttemptPayloadKind>;

// ── QuestionKind → payload archetype mapping ────────────────────────────────
//
// The gating policy: which archetype an attempt on a given QuestionKind must use.
// Exhaustive `Record<QuestionKindT, …>` — adding a new QuestionKind breaks the
// typecheck here until its archetype is declared (intentional forcing function).
//
// Per the grounded plan, only the CLEAN objective kinds are structured first
// (choice / true_false / fill_blank — all route exact|keyword, both in
// OBJECTIVE_JUDGE_ROUTES). Everything else falls back to free_text:
//   - computation: routes keyword|semantic by rubric (not a clean objective
//     archetype) → free_text for now. OWNER OPEN QUESTION #2: should computation
//     answers carry the `numeric` archetype ({value, unit})? Deferred to A5.
//   - derivation / short_answer / essay / reading / translation: prose / semantic.
export const ATTEMPT_PAYLOAD_KIND_BY_QUESTION_KIND: Record<QuestionKindT, AttemptPayloadKindT> = {
  choice: 'choice',
  true_false: 'true_false',
  fill_blank: 'fill_blank',
  computation: 'free_text',
  short_answer: 'free_text',
  essay: 'free_text',
  reading: 'free_text',
  translation: 'free_text',
  derivation: 'free_text',
};

/** The attempt-payload archetype an attempt on `kind` must use. */
export function expectedAttemptPayloadKind(kind: QuestionKindT): AttemptPayloadKindT {
  return ATTEMPT_PAYLOAD_KIND_BY_QUESTION_KIND[kind];
}

const SCHEMA_BY_PAYLOAD_KIND = {
  choice: ChoiceAttemptPayload,
  true_false: TrueFalseAttemptPayload,
  fill_blank: FillBlankAttemptPayload,
  numeric: NumericAttemptPayload,
  free_text: FreeTextAttemptPayload,
} as const satisfies Record<AttemptPayloadKindT, z.ZodTypeAny>;

/** The single discriminated-union member schema for `kind`'s archetype. */
export function attemptPayloadSchemaForKind(kind: QuestionKindT) {
  return SCHEMA_BY_PAYLOAD_KIND[expectedAttemptPayloadKind(kind)];
}

/**
 * Parse `payload` against the archetype required for `kind`. A wrong-type payload
 * (e.g. a `true_false` payload on a `choice` question, or a missing/foreign
 * discriminant) THROWS — this is the structured "错型 reject" acceptance gate.
 */
export function parseAttemptPayloadForKind(kind: QuestionKindT, payload: unknown): AttemptPayloadT {
  return attemptPayloadSchemaForKind(kind).parse(payload) as AttemptPayloadT;
}

/** Non-throwing variant — returns Zod's SafeParseReturn for the kind's archetype. */
export function safeParseAttemptPayloadForKind(kind: QuestionKindT, payload: unknown) {
  return attemptPayloadSchemaForKind(kind).safeParse(payload);
}
