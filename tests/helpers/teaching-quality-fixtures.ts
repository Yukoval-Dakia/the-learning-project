// YUK-578 — shared teaching-quality mock fixtures.
//
// Single source of truth for the TeachingQualityTask LLM-output shape the入池前审题闸
// consumes, used by BOTH partitions: verify-framework.test.ts (unit, golden set) and
// quiz_verify.test.ts (db, wiring). Dependency-free (no db/testcontainer imports) so the
// unit partition can import it — mirrors solve-check-fixtures.ts.
//
// PROMPT-CHANGE DISCIPLINE: the TeachingQualityTask prompt (registry.ts) is calibrated
// against the mini golden set in verify-framework.test.ts. Any change to that prompt (or
// to this output contract) MUST be re-validated against those fixtures before shipping.

/** TeachingQualityTask output. runTeachingQualityCheck reads clarity/unique_answer
 * (mandatory) + distractor_power (choice-only; code forces 'skipped' for non-choice). Pass
 * `distractorPower: null` to OMIT the distractor axis (e.g. non-choice or absent verdict). */
export function teachingQualityOutput(
  opts: {
    clarity?: 'pass' | 'fail';
    uniqueAnswer?: 'pass' | 'fail';
    distractorPower?: 'pass' | 'fail' | null;
  } = {},
): string {
  const obj: Record<string, unknown> = {
    clarity: { verdict: opts.clarity ?? 'pass', reason: 'stem clarity assessment' },
    unique_answer: { verdict: opts.uniqueAnswer ?? 'pass', reason: 'unique-answer assessment' },
    summary: `teaching-quality summary (clarity=${opts.clarity ?? 'pass'})`,
  };
  if (opts.distractorPower !== null) {
    obj.distractor_power = {
      verdict: opts.distractorPower ?? 'pass',
      reason: 'distractor diagnostic-power assessment',
    };
  }
  return JSON.stringify(obj);
}
