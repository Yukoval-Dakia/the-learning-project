/**
 * QA r4 holdout latency/cost (PR #1740 comment 6243725363, head c1158779d).
 * The admission loop is serial, so wall clock is the sum of per-item time.
 *
 * Dry run: 7.3 min, 30/30 returned, no censoring at 90s.
 * Live run: 14.7 min, 25 returned, 5 right-censored at 90_000 ms (all derivative
 * questions). The censored wait accounts for the 450_000 ms gap; completed calls total
 * 432_000 ms (17_280 mean), close to the dry-run 14_600 ms. Completed calls are all
 * < 90s; the 5 censored calls only bound their time below.
 *
 * A single timeout is twice the censoring point: for the censored tail the exponential
 * residual mean is 90s + 90s. `AssessmentRubricJudgeTask.budget.timeout` can override it
 * through resolveTaskBudget.
 *
 * Cost: 55 successful calls cost 44_700 µ$; a timeout has no settled price, so retry
 * gating reserves the rounded mean rather than the old $0.02 placeholder. The runner
 * does not retry budget_timeout, so this single retry lives in the executor.
 */

export const QA_R4_RUBRIC_LATENCY = {
  censorMs: 90_000,
  bindingWallMs: 882_000,
  bindingItems: 30,
  bindingCensored: 5,
  dryWallMs: 438_000,
  dryItems: 30,
} as const;

export const QA_R4_SUCCESSFUL_CALLS = 55;
export const QA_R4_SUCCESSFUL_COST_MICROS = 44_700;

/** Estimated price of one successful call (µ$). Retry only while one more still fits the cap. */
export const ASSESSMENT_RUBRIC_ESTIMATED_ATTEMPT_MICROS = Math.ceil(
  QA_R4_SUCCESSFUL_COST_MICROS / QA_R4_SUCCESSFUL_CALLS,
);

/** One retry after a timeout; other failures do not use this path. */
export const ASSESSMENT_RUBRIC_TIMEOUT_RETRIES = 1;

/**
 * Derive the per-call timeout from the censored holdout. Throws when the sample no
 * longer has the assumed shape, rather than silently keeping a mismatched number.
 */
export function assessmentRubricTimeoutFromCensoredHoldout(
  sample: typeof QA_R4_RUBRIC_LATENCY = QA_R4_RUBRIC_LATENCY,
): number {
  const uncensoredCount = sample.bindingItems - sample.bindingCensored;
  const uncensoredMass = sample.bindingWallMs - sample.bindingCensored * sample.censorMs;
  if (uncensoredCount <= 0 || uncensoredMass <= 0 || sample.dryItems <= 0) {
    throw new Error('censored holdout does not identify a completed-call mass');
  }
  const slowdown = uncensoredMass / uncensoredCount / (sample.dryWallMs / sample.dryItems);
  if (slowdown > 1.5) {
    throw new Error('completed-call slowdown is too large for the censor-residual derivation');
  }
  return sample.censorMs * 2;
}

/** Wall clock for one admission call: initial timeout plus one full retry window. */
export function assessmentRubricInvocationWindowMs(timeoutMs: number): number {
  return timeoutMs * (1 + ASSESSMENT_RUBRIC_TIMEOUT_RETRIES);
}

/**
 * Whether one more paid attempt fits after a timeout. knownSpent is settled µ$;
 * unknownAttempts includes the just-timed-out call, which has no settled price.
 */
export function assessmentRubricTimeoutRetryFits(
  knownSpent: number,
  unknownAttempts: number,
  cap: number,
): boolean {
  const held = knownSpent + (unknownAttempts + 1) * ASSESSMENT_RUBRIC_ESTIMATED_ATTEMPT_MICROS;
  return Number.isFinite(held) && held <= cap;
}
