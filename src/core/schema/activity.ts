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

// T-QP (YUK-165, ADR-0014 §1) — activity-level identity for a part. A part is
// physically a `question` row (kind='question_part'), so its STORAGE / FSRS /
// review identity is `questionRef(partQuestionId)` with subject_kind='question'.
// This helper expresses the *composition* semantics at the activity layer; it does
// NOT change where the part is stored or scheduled. See the lane plan §data-model.
export function questionPartRef(partQuestionId: string): ActivityRefT {
  return { kind: 'question_part', id: partQuestionId };
}
