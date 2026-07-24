import { SourceSpanLocator } from '@/core/schema/question-generation-grounding';
import { z } from 'zod';

export const QuestionAuthorIntentSchema = z
  .object({
    seed_mode: z.enum(['knowledge', 'material']),
    knowledge_ids: z.array(z.string().min(1)).min(1),
    requested_kind: z.string().min(1).optional(),
    difficulty: z.number().int().min(1).max(5).optional(),
    material_body_md: z.string().min(1).max(20_000).optional(),
    material_answer_anchor: z
      .object({
        canonical_answer: z.object({ kind: z.string().min(1), value: z.string().min(1) }),
        locator: SourceSpanLocator,
      })
      .optional(),
    material_title: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.seed_mode === 'material' && !value.material_body_md?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['material_body_md'],
        message: "seed_mode 'material' requires material_body_md",
      });
    }
    if (value.seed_mode === 'material' && !value.material_answer_anchor) {
      ctx.addIssue({
        code: 'custom',
        path: ['material_answer_anchor'],
        message: "seed_mode 'material' requires material_answer_anchor",
      });
    }
  });
