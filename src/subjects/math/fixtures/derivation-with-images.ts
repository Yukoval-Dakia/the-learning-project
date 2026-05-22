import { z } from 'zod';
import { DerivationFixtureItemSchema } from './derivation';
import fixtureData from './derivation-with-images-data.json' with { type: 'json' };

// Same shape as plain derivation, plus image_refs.
export const DerivationWithImagesItemSchema = DerivationFixtureItemSchema.extend({
  image_refs: z.array(z.string().min(1)).min(1),
});
export type DerivationWithImagesItem = z.infer<typeof DerivationWithImagesItemSchema>;

export const DerivationWithImagesFileSchema = z.object({
  version: z.string(),
  subject_id: z.literal('math'),
  items: z.array(DerivationWithImagesItemSchema).min(1),
});

export function loadMathDerivationImageFixtures(): DerivationWithImagesItem[] {
  return DerivationWithImagesFileSchema.parse(fixtureData).items;
}
