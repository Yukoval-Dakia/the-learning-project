// YUK-193 — SolutionGenerateTask LLM structured output.
//
// The generator's job is to produce a reference_solution (the same shape the
// shipped StepsJudge consumes from rubric_json) PLUS a human-readable worked
// solution. reference_solution reuses RubricReferenceSolution (single source of
// truth in business.ts) so the generated value drops straight into the rubric.
import { z } from 'zod';
import { RubricReferenceSolution } from './business';

export const SolutionGenerateOutput = z.object({
  reference_solution: RubricReferenceSolution.extend({
    // FULL validation treats these as the complete, atomized necessary path.
    // Bound both cardinality and item size so every operation can be sealed and
    // reviewed structurally without a later audit-only parse failure.
    expected_signals: z.array(z.string().min(1).max(1000)).min(1).max(12),
  }),
  // Shared by ordinary solve-check and intervention FULL validation. Keeping
  // the capacity bound here makes an oversized provider response a bounded,
  // retryable contract miss instead of a later intervention-audit exception.
  worked_solution_md: z.string().min(1).max(12_000),
  confidence: z.number().min(0).max(1),
});
export type SolutionGenerateOutputT = z.infer<typeof SolutionGenerateOutput>;
