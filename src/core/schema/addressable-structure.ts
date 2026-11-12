import { z } from 'zod';
import { LearnerHandwritingMarker } from './assessment/materials';
import { QuestionKind } from './business';
import type { AddressableStructure } from './structured_question';

const AddressableFigureSchema = z.object({
  asset_id: z.string(),
  role: z.string(),
  attached_to_index: z.string(),
  contains_learner_handwriting: LearnerHandwritingMarker,
});

const AddressableNodeSchema: z.ZodType<AddressableStructure['tree']> = z.lazy(() =>
  z.object({
    id: z.string(),
    role: z.enum(['stem', 'sub', 'standalone']),
    question_no: z.string().optional(),
    prompt_text: z.string(),
    options: z.array(z.object({ label: z.string(), text: z.string() })).optional(),
    answers: z.array(z.string()).optional(),
    analysis: z.string().optional(),
    kind: QuestionKind.optional(),
    sub_questions: z.array(AddressableNodeSchema).optional(),
  }),
);

export const AddressableStructureSchema = z.object({
  tree: AddressableNodeSchema,
  figures: z.array(AddressableFigureSchema),
});
