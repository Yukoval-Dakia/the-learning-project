import { z } from 'zod';

// ADR-0014 §1: 'question' is one activity kind, not the only kind.
export const ActivityKind = z.enum([
  'question',
  'question_part',
  'record',
  'recall_prompt',
  'practice_log',
  'project_milestone',
  'open_inquiry',
]);
export type ActivityKindT = z.infer<typeof ActivityKind>;

export const ActivityRef = z.object({
  kind: ActivityKind,
  id: z.string().min(1),
});
export type ActivityRefT = z.infer<typeof ActivityRef>;

export function questionRef(questionId: string): ActivityRefT {
  return { kind: 'question', id: questionId };
}
