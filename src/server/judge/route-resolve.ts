// F0 (PR #309 round-3, YUK-215) — leaf judge-route resolution module.
//
// `resolveQuestionJudgeRoute` used to live in
// `@/server/ai/judges/question-contract`, which sits inside the judges-barrel
// cluster (it re-exports / pulls the semantic-judge runner, the `JudgeKind`
// union from the judges index, etc.). When `app/api/review/submit/route.ts`
// began importing that resolver DIRECTLY at the top level (PR #309 round-2,
// commit c46054b1), webpack folded the barrel cluster's chunk into the
// review-submit module graph in a way that poisoned a shared client chunk:
// `next build` then crashed while prerendering a PURE-CLIENT page with
// `TypeError: Cannot read properties of undefined (reading 'call')` from the
// webpack-runtime `require`.
//
// Empirically bisected (rm -rf .next && pnpm build per commit):
//   5657c52f (parent)  → green
//   a12c5977 (make-paper round-2) → green
//   c46054b1 (this import edge)   → red (/coach prerender fails)
// Repointing the route to a leaf module with NO judges-barrel dependency turns
// the build green again.
//
// This module depends ONLY on `@/core/schema/business` (enums + Rubric) and
// slim row/profile types — never a judge runner — so any route may import the
// resolver without dragging the barrel cluster into its chunk graph.
// `question-contract.ts` and `invoker.ts` re-import the resolver from here, so
// the public surface and behaviour are unchanged.
//
// M5 (YUK-321) 后注：上文 webpack/next build 叙述是历史语境（Next 栈已拆，
// app/api/review/submit 现为 src/capabilities/practice/api/submit.ts）；esbuild
// server bundle 无共享 client chunk 问题，但 leaf 拆分维持——依赖图越瘦越好，
// 且 question-contract/invoker 的 re-import 面未变。

import type { z } from 'zod';

import { JudgeKind as JudgeKindSchema, QuestionKind, Rubric } from '@/core/schema/business';
import type { SubjectProfile } from '@/subjects/profile';

// `JudgeKind` is the bare union declared in the judges barrel
// (`@/server/ai/judges`). Re-declaring the type-only alias here — instead of
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
 * `judge_kind_override` / `image_refs`. The remaining fields below mirror
 * `JudgeQuestionRow` (question-contract.ts) and the optional index-friendly
 * extras so callers holding a full `JudgeQuestionRow` — and the test literals
 * carrying `id` / `prompt_md` / `reference_md` / `metadata` / `knowledge_ids` —
 * pass their existing row as-is without TS excess-property errors. Kept
 * structurally compatible with `JudgeQuestionRow`.
 */
export interface JudgeRouteQuestionRow {
  kind: string;
  rubric_json: unknown;
  choices_md: string[] | null;
  judge_kind_override: string | null;
  image_refs?: string[];
  // Mirror the rest of JudgeQuestionRow so a full row passes without TS
  // excess-property errors (these fields are not read by the resolver).
  id?: string;
  prompt_md?: string;
  reference_md?: string | null;
  knowledge_ids?: string[] | null;
  metadata?: Record<string, unknown> | null;
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

function parseRubric(raw: unknown): z.infer<typeof Rubric> | null {
  if (raw === null || raw === undefined) return null;
  const parsed = Rubric.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function nonEmpty(values: string[] | undefined): string[] {
  return (values ?? []).map((v) => v.trim()).filter((v) => v.length > 0);
}

function parseRoute(value: string | null | undefined): JudgeRoute | null {
  const parsed = JudgeKindSchema.safeParse(value);
  return parsed.success ? (parsed.data as JudgeRoute) : null;
}

function isPreferred(profile: SubjectProfile, route: JudgeRoute): boolean {
  return profile.judgePolicy.preferredRoutes.includes(route);
}

/**
 * Resolve the judge route the invoker WOULD dispatch for a question. Pure +
 * dependency-light (no judge runners, no capability registry, no DB). Behaviour
 * is byte-for-byte identical to the former question-contract.ts implementation.
 */
export function resolveQuestionJudgeRoute(
  q: JudgeRouteQuestionRow,
  subjectProfile: SubjectProfile,
): JudgeRoute {
  const override = parseRoute(q.judge_kind_override);
  if (override) return override;

  // A question with persisted choices is structurally a multiple/single-choice
  // item regardless of the kind string the subject profile uses
  // (e.g. wenyan exposes 'single_choice' / 'multiple_choice' while the
  // QuestionKind enum still calls the canonical kind 'choice'). The structure
  // is the source of truth: if there are choices, the only safe default is
  // exact match against reference_md — never spend LLM budget on a semantic
  // judge for what is fundamentally a string compare.
  const choices = q.choices_md ?? [];
  if (choices.length > 0) return 'exact';

  if (
    subjectProfile.id === 'physics' &&
    isPreferred(subjectProfile, 'unit_dimension') &&
    (q.kind === 'calculation' || q.kind === 'computation')
  ) {
    return 'unit_dimension';
  }

  const kind = QuestionKind.safeParse(q.kind).success ? q.kind : 'short_answer';
  const rubric = parseRubric(q.rubric_json);
  const keywords = nonEmpty(rubric?.keywords);

  if (kind === 'choice' || kind === 'true_false') return 'exact';
  if (kind === 'fill_blank') return keywords.length > 0 ? 'keyword' : 'exact';
  if (kind === 'computation') return keywords.length > 0 ? 'keyword' : 'semantic';
  // M2.1 (2026-05-22): derivation always routes via steps@1 for profiles that
  // declare it (math); other profiles fall back to semantic if preferred, else
  // keyword. M2.2 made 'steps' runnable via runStepsJudge (vision LLM call).
  if (kind === 'derivation') {
    if (isPreferred(subjectProfile, 'steps')) return 'steps';
    return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
  }
  // YUK-201 — gated auto-route to multimodal_direct (holistic vision judging).
  // Placed AFTER the physics unit_dimension branch and AFTER the
  // derivation→steps branch so steps@1 keeps math derivations and physics calc
  // keeps unit_dimension. Additive — fires only when ALL hold:
  //   - kind is non-choice (choices short-circuit to 'exact' earlier) and
  //     non-derivation (handled above);
  //   - the question carries prompt figures (q.image_refs?.length > 0);
  //   - the profile declares multimodal_direct as a preferred route (wenyan/math
  //     do NOT → unaffected; only physics opts in);
  //   - there is NO step-rubric reference_solution (a rubric reference_solution
  //     belongs to steps@1, never multimodal_direct).
  if (
    (q.image_refs?.length ?? 0) > 0 &&
    isPreferred(subjectProfile, 'multimodal_direct') &&
    rubric?.reference_solution == null
  ) {
    return 'multimodal_direct';
  }
  if (kind === 'short_answer' || kind === 'reading' || kind === 'translation' || kind === 'essay') {
    return isPreferred(subjectProfile, 'semantic') ? 'semantic' : 'keyword';
  }
  return 'exact';
}
