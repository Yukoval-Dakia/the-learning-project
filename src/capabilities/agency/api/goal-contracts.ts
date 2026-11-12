import { z } from 'zod';
import { DeclaredStage } from '@/core/schema/business';

export const CreateGoalBody = z.object({
  title: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),
  knowledgeIds: z.array(z.string().min(1)).optional(),
  // Learner-declared curriculum stage (学段). Companion/teaching headers, question
  // preparation, quiz generation, and hints read it as a course constraint.
  // Optional; NEVER an ability/θ̂ input.
  declaredStage: DeclaredStage.nullable().optional(),
});

export const GoalSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
  })
  .passthrough();
