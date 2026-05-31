import { Rubric } from '@/core/schema/business';
import { z } from 'zod';
import fixtureData from './data.json' with { type: 'json' };

// P5.8 (2026-05-31, YUK-182): wenyan eval fixture — the FIRST subject fixture
// to gate the SEMANTIC judge route (translation / reading_comprehension), the
// next validation frontier after exact/keyword (math) and unit_dimension
// (physics). Fixture schema is subject-local — does NOT touch framework schema
// (src/core/schema/*), same boundary the physics fixture documents
// (physics/fixtures/index.ts:4-8). No new production schema / migration / UI /
// judge / profile change; the wenyan profile + all three routes (exact /
// keyword / semantic) already exist.
// See docs/superpowers/specs/2026-05-31-p5.8-wenyan-eval-fixtures-design.md.

export const WenyanFixtureItemSchema = z
  .object({
    ref: z.string().min(1),
    // The wenyan profile's own kind strings (profile.ts:8-14) — single_choice /
    // translation / reading_comprehension / short_answer — PLUS 'fill_blank',
    // which is a canonical QuestionKind (business.ts:19), not a wenyan profile
    // kind, included solely to gate the keyword route (F-1/H1/AC-5; routes
    // 'keyword' iff rubric_json.keywords is non-empty, question-contract.ts:146,
    // else 'exact'). Routing is decided by the contract bridging profile-vs-
    // canonical kinds (F-1, F-2):
    //   single_choice        → exact   (structural choices short-circuit, :130-131)
    //   translation          → semantic (in QuestionKind enum, :155-156)
    //   reading_comprehension → semantic (NOT in enum → short_answer fallback :141 → :155-156)
    //   fill_blank+keywords  → keyword  (:146)
    // F-2 follow-up (§9 Q5): reading_comprehension → 'reading' naming drift; the
    // routing is already correct via the short_answer fallback, tracked low-pri.
    kind: z.enum([
      'single_choice',
      'translation',
      'reading_comprehension',
      'short_answer',
      'fill_blank',
    ]),
    prompt_md: z.string().min(1),
    choices_md: z.array(z.string().min(1)).optional(), // F-1: present for single_choice
    reference_md: z.string().min(1),
    // F-3: semantic items carry required_points (the scoring points the stubbed
    // judge matches against); fill_blank carries keywords for the keyword route.
    // Rubric REQUIRES a `criteria` array (business.ts:172-184), so each item's
    // rubric_json must be { criteria: [], required_points?: [...] / keywords?: [...] }.
    rubric_json: Rubric.optional(),
    difficulty: z.number().int().min(1).max(5),
    knowledge_hint: z.string().min(1), // maps to curriculum.json seed name (F-6)
  })
  // PR #228 review (CodeRabbit, Major): choices_md / rubric_json are structurally
  // optional, so the kind→field invariants below would otherwise rest only on the
  // index.test.ts assertions. Move them into the schema so an invalid fixture
  // fails at parse/load time (invariant-in-schema, matching the audit philosophy).
  .superRefine((item, ctx) => {
    if (item.kind === 'single_choice' && (item.choices_md?.length ?? 0) < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'single_choice 必须提供 choices_md，且至少 2 个选项',
        path: ['choices_md'],
      });
    }
    if (
      (item.kind === 'translation' || item.kind === 'reading_comprehension') &&
      !item.rubric_json?.required_points?.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'translation/reading_comprehension 必须提供 rubric_json.required_points',
        path: ['rubric_json', 'required_points'],
      });
    }
    if (item.kind === 'fill_blank' && !item.rubric_json?.keywords?.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'fill_blank 必须提供 rubric_json.keywords',
        path: ['rubric_json', 'keywords'],
      });
    }
  });
export type WenyanFixtureItem = z.infer<typeof WenyanFixtureItemSchema>;

export const WenyanFixtureFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('wenyan'),
  items: z.array(WenyanFixtureItemSchema).min(10).max(12),
});

export function loadWenyanFixtures(): WenyanFixtureItem[] {
  return WenyanFixtureFileSchema.parse(fixtureData).items;
}
