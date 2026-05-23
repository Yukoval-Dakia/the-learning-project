import { z } from 'zod';

export const SignalKind = z.enum([
  'numeric_close',
  'numeric_off',
  'unit_mismatch_same_dimension',
  'dimension_mismatch',
  'missing_unit',
  'unparseable',
]);
export type SignalKindT = z.infer<typeof SignalKind>;

export const UnitDimensionJudgeInput = z.object({
  student_answer: z.string().min(1),
  reference: z.object({
    value: z.number(),
    unit: z.string(),
    tolerance: z.number().min(0).default(0.05),
  }),
  question_context_md: z.string().optional(),
});
export type UnitDimensionJudgeInputT = z.infer<typeof UnitDimensionJudgeInput>;

export const LlmFallbackOutput = z.object({
  student_value_si: z.number().nullable(),
  student_unit_si: z.string().nullable(),
  equivalent_to_reference: z.boolean(),
  dimension_mismatch_reason: z.string().optional(),
  parser_confidence: z.number().min(0).max(1),
});
export type LlmFallbackOutputT = z.infer<typeof LlmFallbackOutput>;
