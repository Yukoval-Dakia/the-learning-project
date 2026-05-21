import { z } from 'zod';
import fixtureData from './data.json' with { type: 'json' };

export const MathFixtureItemSchema = z.object({
  ref: z.string().min(1),
  kind: z.enum(['single_choice', 'fill_blank']),
  prompt_md: z.string().min(1),
  choices_md: z.array(z.string().min(1)).optional(),
  reference_md: z.string().min(1),
  rubric_json: z
    .object({
      criteria: z.array(z.unknown()).default([]),
      keywords: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  difficulty: z.number().int().min(1).max(5),
  knowledge_hint: z.string().min(1),
});
export type MathFixtureItem = z.infer<typeof MathFixtureItemSchema>;

export const MathFixtureFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('math'),
  items: z.array(MathFixtureItemSchema).min(1),
});

export function loadMathFixtures(): MathFixtureItem[] {
  return MathFixtureFileSchema.parse(fixtureData).items;
}
