import { z } from 'zod';
import { DeclaredStage } from '@/core/schema/business';

export const CreateGoalBody = z.object({
  title: z.string().min(1),
  subjectId: z.string().min(1).nullable().optional(),
  knowledgeIds: z.array(z.string().min(1)).optional(),
  // YUK-1009 — learner-declared curriculum stage (学段), persisted on the goal as a
  // durable curriculum constraint (consumed by question supply, e.g. the jyeoo grade
  // route). Optional — omitting it leaves the goal undeclared. NEVER an ability/θ̂ input.
  declaredStage: DeclaredStage.nullable().optional(),
});

export const GoalSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
  })
  .passthrough();
