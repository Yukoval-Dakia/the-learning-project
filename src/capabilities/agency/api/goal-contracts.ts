import { z } from 'zod';

export const CreateGoalBody = z.object({
  title: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),
  knowledgeIds: z.array(z.string().min(1)).optional(),
});

export const GoalSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
  })
  .passthrough();
