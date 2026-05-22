import { RubricReferenceSolution } from '@/core/schema/business';
import { z } from 'zod';
import fixtureData from './derivation-data.json' with { type: 'json' };

export const DerivationFixtureItemSchema = z.object({
  ref: z.string().min(1),
  kind: z.literal('derivation'),
  prompt_md: z.string().min(1),
  reference_md: z.string().min(1),
  rubric_json: z.object({
    criteria: z.array(z.object({ name: z.string(), weight: z.number(), descriptor: z.string() })),
    // M2.2 reviewer note: reuse canonical RubricReferenceSolution to avoid
    // drift between fixture schema and the source of truth in business.ts.
    reference_solution: RubricReferenceSolution,
  }),
  difficulty: z.number().int().min(1).max(5),
  knowledge_hint: z.string().min(1),
});
export type DerivationFixtureItem = z.infer<typeof DerivationFixtureItemSchema>;

export const DerivationFixtureFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('math'),
  items: z.array(DerivationFixtureItemSchema).min(1),
});

export function loadMathDerivationFixtures(): DerivationFixtureItem[] {
  return DerivationFixtureFileSchema.parse(fixtureData).items;
}
