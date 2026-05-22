import { z } from 'zod';

const CAUSE_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export const CauseCategoryDeclaration = z.object({
  id: z.string().min(1).regex(CAUSE_ID_PATTERN, {
    message: 'cause id must be lowercase alphanumeric + underscores, starting with a letter',
  }),
  label: z.string().min(1),
  description: z.string().optional(),
  review_priority: z
    .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)])
    .optional(),
  variant_targetable: z.boolean().optional(),
  source_pack: z
    .object({
      id: z.string().min(1),
      version: z.string().min(1),
    })
    .optional(),
});
export type CauseCategoryDeclarationT = z.infer<typeof CauseCategoryDeclaration>;

export const RenderConfig = z.object({
  font_family: z.string().min(1),
  notation: z.string().nullable(),
  code_highlight: z.string().nullable(),
});
export type RenderConfigT = z.infer<typeof RenderConfig>;

export const SchedulingHints = z.object({
  default_policy: z.string().min(1),
});
export type SchedulingHintsT = z.infer<typeof SchedulingHints>;
