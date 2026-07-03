// YUK-554 (review R1/R2) — shared solve-check mock fixtures.
//
// Single source of truth for the two LLM-output shapes solve-check consumes, used by
// BOTH partitions: verify-framework.test.ts (unit) and quiz_verify.test.ts (db). This
// file must stay dependency-free (no db/testcontainer imports) so the unit partition
// can import it. source_verify.test.ts keeps its own minimal local solverOutput by
// review裁决 (only comments may be added there) — if the consumed shape changes, update
// it in lockstep (it carries a pointer comment back here).

/** SolutionGenerateTask output. runSolveCheck reads only reference_solution.final_answer
 * + answer_equivalents; the extra fields mirror the real task's fuller shape. */
export function solverOutput(finalAnswer: string, equivalents: string[] = []): string {
  return JSON.stringify({
    reference_solution: {
      expected_signals: ['s'],
      final_answer: finalAnswer,
      answer_equivalents: equivalents,
    },
    worked_solution_md: 'work',
    confidence: 0.9,
  });
}

/** SemanticJudgeTask output (SemanticJudgeOutput schema) for the open-question solve
 * path — only a confident 'incorrect' (confidence >= 0.8) makes solve-check fail. */
export function semanticJudgeOutput(
  outcome: 'correct' | 'partial' | 'incorrect',
  confidence: number,
): string {
  return JSON.stringify({
    score: outcome === 'incorrect' ? 0 : outcome === 'partial' ? 0.5 : 0.9,
    coarse_outcome: outcome,
    confidence,
    feedback_md: 'fb',
    evidence_json: { matched_points: [], missing_points: [] },
  });
}
