// Leaf judge-route resolver.
// Kept free of judge-runner and barrel imports so routes can resolve a route without
// dragging the judges cluster into their bundle graph. question-contract and invoker
// re-import it, so the public surface is unchanged.

import type { z } from 'zod';

import { deriveAnswerClass, isKeywordConditionalAnswerKind } from '@/core/schema/answer-class';
import { JudgeKind as JudgeKindSchema, Rubric } from '@/core/schema/business';
import type { SubjectProfile } from '@/subjects/profile';

// `JudgeKind` is the bare union declared in the judges barrel
// (`@/capabilities/practice/server/judge`). Re-declaring the type-only alias here — instead of
// importing it — keeps this leaf free of any value edge to the barrel. Kept in
// lockstep with the barrel's `JudgeKind` union.
export type JudgeRoute =
  | 'exact'
  | 'keyword'
  | 'semantic'
  | 'rubric'
  | 'steps'
  | 'unit_dimension'
  | 'multimodal_direct'
  | 'ai_flexible';

/**
 * Question shape the route resolver reads. SELF-CONTAINED — this leaf imports
 * NOTHING from the judges barrel (not even a type), so the F0 build regression
 * cannot reappear through any import edge (value OR type-only re-export cycle).
 *
 * The resolver only reads `kind` / `rubric_json` / `choices_md` /
 * `judge_kind_override` / `image_refs` / `metadata`. The remaining fields below
 * mirror `JudgeQuestionRow` (question-contract.ts) and the optional
 * index-friendly extras so callers holding a full `JudgeQuestionRow` — and the
 * test literals carrying `id` / `prompt_md` / `reference_md` / `knowledge_ids` —
 * pass their existing row as-is without TS excess-property errors. Kept
 * structurally compatible with `JudgeQuestionRow`.
 */
export interface JudgeRouteQuestionRow {
  kind: string;
  rubric_json: unknown;
  choices_md: string[] | null;
  judge_kind_override: string | null;
  image_refs?: string[];
  // Read by the unit_dimension branch: the runner's input contract
  // lives here — see hasUnitDimensionReference.
  metadata?: Record<string, unknown> | null;
  // Mirror the rest of JudgeQuestionRow so a full row passes without TS
  // excess-property errors (these fields are not read by the resolver).
  id?: string;
  prompt_md?: string;
  reference_md?: string | null;
  knowledge_ids?: string[] | null;
  figures?: unknown[];
  structured?: unknown;
}

// The ONLY judge routes that consume `student_image_refs` (handwriting-photo
// answers). Verified against the invoker dispatch (invoker.ts dispatch table):
// `steps` and `multimodal_direct` thread `input.student_image_refs` into their
// runners; every other route (`exact`/`keyword`/`semantic`/`unit_dimension`)
// reads ONLY the text answer. A photo-only answer (empty text + image refs)
// routed to a text-only judge would be scored against the empty string — a
// false "wrong" that pollutes FSRS. Shared by /api/review/submit (F4) and
// paper-submit (F1) so the gate cannot drift between the two flows. Keep in sync
// with the invoker if a new image-aware route lands.
export const IMAGE_CONSUMING_JUDGE_ROUTES = new Set<JudgeRoute>(['steps', 'multimodal_direct']);

// (High-sec) — the judge routes whose verdict comes from an LLM call.
// The invoker dispatches exactly these four through `runTaskFn`
// (semantic → runSemanticJudge, steps → runStepsJudge, multimodal_direct →
// runMultimodalDirectJudge, unit_dimension → runUnitDimensionJudge). `exact` /
// `keyword` are deterministic local string comparisons that NEVER call a model;
// `rubric` / `ai_flexible` have no runner — dispatch returns `unsupported`
// (, see UNIMPLEMENTED_JUDGE_ROUTES in question-contract.ts).
// Provenance discipline: when a route's `invoked.execution` metadata is ABSENT,
// the meaning differs by route class. For a model-backed route it means the LLM
// call FAILED (provider timeout / crash → coarse_outcome='unsupported'), so the
// stamp must be `historical_unknown` — NOT `deterministic`, which would falsely
// claim no model was ever meant to run (a timeout masquerading as a no-model
// deterministic verdict). For a genuinely deterministic route absent execution
// is the normal, honest case. Keep in sync with the invoker dispatch table.
export const MODEL_BACKED_JUDGE_ROUTES = new Set<JudgeRoute>([
  'semantic',
  'steps',
  'multimodal_direct',
  'unit_dimension',
]);

/** True iff the route's verdict is produced by an LLM call (see MODEL_BACKED_JUDGE_ROUTES). */
export function isModelBackedJudgeRoute(route: string): boolean {
  return MODEL_BACKED_JUDGE_ROUTES.has(route as JudgeRoute);
}

function parseRubric(raw: unknown): z.infer<typeof Rubric> | null {
  if (raw === null || raw === undefined) return null;
  const parsed = Rubric.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function parseRoute(value: string | null | undefined): JudgeRoute | null {
  const parsed = JudgeKindSchema.safeParse(value);
  return parsed.success ? (parsed.data as JudgeRoute) : null;
}

function isPreferred(profile: SubjectProfile, route: JudgeRoute): boolean {
  return profile.judgePolicy.preferredRoutes.includes(route);
}

// the two kind labels that triggered the unit_dimension preference
// before this ticket ('calculation' is the legacy profile-vocab label,
// 'computation' the canonical one). They stay ONLY as a grandfathered
// preference key so rows persisted before/without the metadata contract keep
// their current route byte-for-byte; the structural contract below is what
// actually detects a calculation-type row.
const LEGACY_UNIT_DIMENSION_KIND_LABELS: ReadonlySet<string> = new Set([
  'calculation',
  'computation',
]);

/**
 * the unit_dimension judge's input contract, mirrored from the
 * runner (core/capability/judges/unit_dimension.ts returns 'unsupported'
 * without it) and enforced by the write-path gate
 * (assertGeneratedQuestionHasJudgeContract in question-contract.ts): the
 * question's metadata must carry a numeric `reference_value` and a string
 * `reference_unit`. The pair has no other producer or consumer, so its
 * presence is the producer's structural declaration that the expected answer
 * is "a number + unit/量纲" — the reliable derived signal for the
 * calculation-type trigger that the kind label used to approximate.
 * made kind a free-form display label, so equivalent labels (计算题 / 应用题 /
 * word_problem / custom vocab) silently missed the literal label check while
 * carrying exactly this contract.
 */
export function hasUnitDimensionReference(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return (
    typeof metadata?.reference_value === 'number' && typeof metadata?.reference_unit === 'string'
  );
}

/**
 * Resolve the judge route the invoker WOULD dispatch for a question. Pure +
 * dependency-light (no judge runners, no capability registry, no DB). Behaviour
 * is byte-for-byte identical to the former question-contract.ts implementation.
 *
 * (kind Step 4): the exact/keyword/semantic/steps classification is a
 * read of the answer-class axis (deriveAnswerClass, core/schema/answer-class.ts
 * the single source of truth); the profile-aware gates (unit_dimension,
 * derivation steps ladder, multimodal_direct) keep their legacy positions on
 * top of it.
 */
export function resolveQuestionJudgeRoute(
  q: JudgeRouteQuestionRow,
  subjectProfile: SubjectProfile,
): JudgeRoute {
  const override = parseRoute(q.judge_kind_override);
  if (override) return override;

  // A question with persisted choices is structurally a multiple/single-choice
  // item regardless of the kind label the subject profile uses
  // (e.g. yuwen rows may be labelled 'single_choice' / 'multiple_choice' while
  // the canonical label vocabulary calls the same shape 'choice'). The
  // structure is the source of truth: if there are choices, the only safe
  // default is exact match against reference_md — never spend LLM budget on a
  // semantic judge for what is fundamentally a string compare.
  const choices = q.choices_md ?? [];
  if (choices.length > 0) return 'exact';

  // Profile-keyed preference: 'unit_dimension' is a subject-declared route
  // preference for calculation-type questions. — the primary trigger
  // is now the unit judge's own input contract (metadata.reference_value:number
  // + reference_unit:string, hasUnitDimensionReference): a structural signal
  // independent of the free-form kind label, so equivalent semantic
  // labels (计算题 / 应用题 / word_problem / custom vocab) carrying the contract
  // no longer miss the route. The two legacy labels stay as a grandfathered
  // preference key — like sourcingRoutePreference's per-kind map, a PREFERENCE
  // KEY, not a closed-set authority — preserving byte-identical routing for
  // rows persisted before/without the contract. Cost direction: a row WITH the
  // pair was authored for exactly this judge (no other producer/consumer), and
  // a misroute WITHOUT it can only yield 'unsupported' — never a false grade —
  // while a missed trigger degrades to the answer-class chain below.
  if (
    isPreferred(subjectProfile, 'unit_dimension') &&
    (LEGACY_UNIT_DIMENSION_KIND_LABELS.has(q.kind) || hasUnitDimensionReference(q.metadata))
  ) {
    return 'unit_dimension';
  }

  // kind is a free-form display label; classify the RAW label.
  // The retired enum fallback rewrote unknown labels to 'short_answer' first;
  // both paths land on 'semantic' inside deriveAnswerClass, so dropping the
  // enum gate is byte-identical for every label (unknown → semantic either
  // way).
  const rubric = parseRubric(q.rubric_json);
  const answerClass = deriveAnswerClass({
    kind: q.kind,
    rubric_json: rubric,
    choices_md: choices,
  });

  switch (answerClass) {
    case 'exact':
      // choice / true_false / fill_blank without rubric keywords
      return 'exact';
    case 'keyword':
      // fill_blank / computation carrying rubric keywords
      return 'keyword';
    case 'steps': {
      // M2.1 (2026-05-22): derivation always routes via steps@1 for profiles that
      // declare it (math); other profiles fall back to semantic if preferred, else
      // keyword. M2.2 made 'steps' runnable via runStepsJudge (vision LLM call).
      if (isPreferred(subjectProfile, 'steps')) return 'steps';
      return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
    }
    case 'semantic': {
      // Two producers land here: the keyword-conditional kind (computation
      // without keywords — its class would be 'keyword' WITH keywords), whose
      // semantic route is unconditional and, in the legacy chain, returned
      // BEFORE the multimodal_direct gate; and prose, which keeps both the gate
      // and the profile ladder below.
      if (isKeywordConditionalAnswerKind(q.kind)) {
        return 'semantic';
      }
      // gated auto-route to multimodal_direct (holistic vision judging).
      // Placed AFTER the profile-declared unit_dimension branch and AFTER the
      // derivation→steps branch so opted-in calculations and derivations keep
      // their specialized routes. Fires only when ALL hold:
      // - kind is non-choice (choices short-circuit to 'exact' earlier) and
      // non-derivation (handled above);
      // - the question carries prompt figures (q.image_refs?.length > 0);
      // - the profile declares multimodal_direct as a preferred route;
      // - there is NO step-rubric reference_solution (a rubric reference_solution
      // belongs to steps@1, never multimodal_direct).
      if (
        (q.image_refs?.length ?? 0) > 0 &&
        isPreferred(subjectProfile, 'multimodal_direct') &&
        rubric?.reference_solution == null
      ) {
        return 'multimodal_direct';
      }
      return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
    }
  }
}
