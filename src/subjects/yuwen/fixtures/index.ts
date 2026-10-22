import { z } from 'zod';
import { Rubric } from '@/core/schema/business';
import fixtureData from './data.json' with { type: 'json' };

// Yuwen evaluation fixture. The schema is subject-local: it never touches the
// framework schema, migration, judge, or profile.

export const YuwenFixtureItemSchema = z
  .object({
    ref: z.string().min(1),
    // Fixtures stay on the known label vocabulary because seed-synthetic persists
    // kind verbatim; routing then follows the label:
    //   choice → exact, translation/reading → semantic, fill_blank+keywords → keyword.
    kind: z.enum(['choice', 'translation', 'reading', 'short_answer', 'fill_blank']),
    prompt_md: z.string().min(1),
    choices_md: z.array(z.string().min(1)).optional(),
    reference_md: z.string().min(1),
    // Semantic items need required_points; fill_blank needs keywords. Rubric
    // requires a criteria array, so rubric_json is { criteria: [], ... }.
    rubric_json: Rubric.optional(),
    difficulty: z.number().int().min(1).max(5),
    knowledge_hint: z.string().min(1), // Matches a curriculum.json seed name.
  })
  // Kind-to-field invariants live in the schema so a bad fixture fails at load,
  // not only in test assertions.
  .superRefine((item, ctx) => {
    if (item.kind === 'choice' && (item.choices_md?.length ?? 0) < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'choice 必须提供 choices_md，且至少 2 个选项',
        path: ['choices_md'],
      });
    }
    if (
      (item.kind === 'translation' || item.kind === 'reading') &&
      !item.rubric_json?.required_points?.length
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'translation/reading 必须提供 rubric_json.required_points',
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
export type YuwenFixtureItem = z.infer<typeof YuwenFixtureItemSchema>;

export const YuwenFixtureFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('yuwen'),
  items: z.array(YuwenFixtureItemSchema).min(10).max(12),
});

export function loadYuwenFixtures(): YuwenFixtureItem[] {
  return YuwenFixtureFileSchema.parse(fixtureData).items;
}
