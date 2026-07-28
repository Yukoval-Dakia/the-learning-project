import { z } from 'zod';

const JsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * Minimal immutable question context needed to interpret a historical learner
 * answer. This is evidence provenance, not a second mutable question model.
 */
export const QuestionEvidenceContextSnapshot = z.object({
  question_id: z.string().min(1),
  question_version: z.number().int().nonnegative(),
  parent_question_id: z.string().min(1).nullable(),
  prompt_md: z.string(),
  reference_md: z.string().nullable(),
  choices_md: z.array(z.string()).nullable(),
  image_refs: z.array(z.string()),
  figures: z.array(JsonObjectSchema),
  updated_at: z.string().datetime(),
});
export type QuestionEvidenceContextSnapshotT = z.infer<typeof QuestionEvidenceContextSnapshot>;

/**
 * Frozen at attempt write time. A part question must carry its shared parent;
 * omitting that stem would make the historical answer uninterpretable.
 */
export const AttemptQuestionSnapshot = z
  .object({
    schema_version: z.literal(1),
    question: QuestionEvidenceContextSnapshot,
    parent_question: QuestionEvidenceContextSnapshot.nullable(),
  })
  .superRefine((snapshot, ctx) => {
    const parentId = snapshot.question.parent_question_id;
    if (parentId === null && snapshot.parent_question !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'parent_question must be null when parent_question_id is null',
        path: ['parent_question'],
      });
    }
    if (parentId !== null && snapshot.parent_question?.question_id !== parentId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'parent_question must match question.parent_question_id',
        path: ['parent_question'],
      });
    }
  });
export type AttemptQuestionSnapshotT = z.infer<typeof AttemptQuestionSnapshot>;
