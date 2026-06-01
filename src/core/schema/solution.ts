// YUK-193 — SolutionGenerateTask LLM structured output.
//
// The generator's job is to produce a reference_solution (the same shape the
// shipped StepsJudge consumes from rubric_json) PLUS a human-readable worked
// solution. reference_solution reuses RubricReferenceSolution (single source of
// truth in business.ts) so the generated value drops straight into the rubric.
import { z } from 'zod';
import { RubricReferenceSolution } from './business';

export const SolutionGenerateOutput = z.object({
  reference_solution: RubricReferenceSolution,
  worked_solution_md: z.string().min(1),
  confidence: z.number().min(0).max(1),
});
export type SolutionGenerateOutputT = z.infer<typeof SolutionGenerateOutput>;
