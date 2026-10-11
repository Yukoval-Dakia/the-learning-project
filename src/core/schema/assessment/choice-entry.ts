import { z } from 'zod';
import { QuestionPresentation } from './presentation';
import { ResponseOption } from './response';
import { OptionSetKeyCriterion } from './scoring';

/** The first entry slice requires printed points, never an invented paper score. */
export const SingleChoiceEntrySpec = z.strictObject({
  kind: z.literal('single_choice'),
  criterion: OptionSetKeyCriterion.extend({
    accepted_option_ids: z.array(z.string().min(1)).length(1),
  }).strict(),
  printed_points: z.number().positive(),
  presentation: QuestionPresentation,
});
export type SingleChoiceEntrySpecT = z.infer<typeof SingleChoiceEntrySpec>;

export const ChoiceEntrySolveInput = z.strictObject({
  subject_id: z.string().min(1),
  part_id: z.string().min(1),
  slot_id: z.string().min(1),
  scoring_unit_id: z.string().min(1),
  prompt_md: z.string().trim().min(1),
  options: z.array(ResponseOption).min(2),
  printed_points: z.number().positive(),
});
export type ChoiceEntrySolveInputT = z.infer<typeof ChoiceEntrySolveInput>;

export const ChoiceEntrySolveOutput = z.strictObject({
  criterion: SingleChoiceEntrySpec.shape.criterion,
  worked_solution_md: z.string().trim().min(1),
  presentation: QuestionPresentation,
  distractors: z.array(
    z.strictObject({ option_id: z.string().min(1), reason_md: z.string().trim().min(1) }),
  ),
});
export type ChoiceEntrySolveOutputT = z.infer<typeof ChoiceEntrySolveOutput>;

/** Captured source prose is evidence for a separate check, never an answer key. */
export const ChoiceEntrySourceReference = z.strictObject({
  reference_md: z.string(),
  source_url: z.string().url(),
  source_title: z.string().min(1),
  extract: z.string().min(1),
  extraction_hash: z.string().min(1).nullable(),
});
export const ChoiceEntrySourceCrosscheckInput = z.strictObject({
  mode: z.literal('source_crosscheck'),
  question: ChoiceEntrySolveInput,
  source: ChoiceEntrySourceReference,
  proposed_answer: ChoiceEntrySolveOutput.pick({ criterion: true, worked_solution_md: true }),
});
export const ChoiceEntrySourceCrosscheckOutput = z.strictObject({
  mode: z.literal('source_crosscheck'),
  status: z.enum(['consistent', 'conflict', 'unknown']),
  reason_md: z.string().trim().min(1),
});
export const ChoiceEntryTaskOutput = z.union([
  ChoiceEntrySolveOutput,
  ChoiceEntrySourceCrosscheckOutput,
]);
export type ChoiceEntrySourceCrosscheckInputT = z.infer<typeof ChoiceEntrySourceCrosscheckInput>;
export type ChoiceEntryTaskOutputT = z.infer<typeof ChoiceEntryTaskOutput>;

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const IndependentChoiceSolve = z.strictObject({
  task_run_id: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  input_digest: Digest,
  output_digest: Digest,
});

export const ChoiceSourceCrosscheck = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('absent'), source: ChoiceEntrySourceReference }),
  z.strictObject({
    kind: z.literal('checked'),
    input: ChoiceEntrySourceCrosscheckInput,
    output: ChoiceEntrySourceCrosscheckOutput,
    receipt: IndependentChoiceSolve,
  }),
]);
export type ChoiceSourceCrosscheckT = z.infer<typeof ChoiceSourceCrosscheck>;

export const ChoiceMethodCalibration = z.strictObject({
  policy_id: z.literal('choice-entry@1'),
  revision_digest: Digest,
  question_input_digest: Digest,
  solves: z.tuple([IndependentChoiceSolve, IndependentChoiceSolve]),
  // Historical evidence remains readable. Prospective validation requires both bindings.
  source_crosscheck: ChoiceSourceCrosscheck.optional(),
  row_input_digest: Digest.optional(),
  scoring_unit_id: z.string().min(1),
  method_version: z.literal('exact-option-set@1'),
  method_digest: Digest,
  probe_digest: Digest,
  probes: z
    .array(
      z.strictObject({
        probe_id: z.string().min(1),
        option_order: z.array(z.string().min(1)).min(2),
        selected_option_ids: z.array(z.string().min(1)),
        expected_points: z.number().min(0),
        actual_points: z.number().min(0).nullable(),
        passed: z.boolean(),
      }),
    )
    .min(1),
  calibrated_at: z.string().datetime(),
});
export type ChoiceMethodCalibrationT = z.infer<typeof ChoiceMethodCalibration>;
