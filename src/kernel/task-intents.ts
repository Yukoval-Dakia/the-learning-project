import { z } from 'zod';

export const GoalScopeIntentSchema = z
  .object({
    goal_title: z.string().trim().min(1),
    subject_id: z.string().min(1).nullable().optional(),
  })
  .strict();

export type GoalScopeIntent = z.infer<typeof GoalScopeIntentSchema>;
