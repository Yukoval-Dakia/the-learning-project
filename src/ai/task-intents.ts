import { z } from 'zod';

export const QuestionAuthorIntentSchema = z
  .object({
    seed_mode: z.enum(['knowledge', 'material']),
    knowledge_ids: z.array(z.string().min(1)).min(1),
    requested_kind: z.string().min(1).optional(),
    difficulty: z.number().min(0).max(1).optional(),
    material_body_md: z.string().min(1).optional(),
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
  });

export const GoalScopeIntentSchema = z
  .object({
    goal_title: z.string().trim().min(1),
    subject_id: z.string().min(1).nullable().optional(),
  })
  .strict();
