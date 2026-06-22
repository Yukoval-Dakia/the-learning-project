// A9 (YUK-438) — step-grading evidence multiplier flags (PURE, no IO).
//
// STEP_GRADING_EVIDENCE_ENABLED=false (DEFAULT) → callers keep today's single binary
// updateThetaForAttempt (flag-off byte-identical regression anchor).
//
// B3 gate floor: item_calibration.confidence on the question's hard track must meet
// this before per-step observations feed θ (judge calibration / B5 admissibility).

/** Dark-ship master switch — flip only after B5 judge calibration is live. */
export const STEP_GRADING_EVIDENCE_ENABLED = false;

/** Minimum item_calibration.confidence for step observations to enter θ (B3). */
export const STEP_GRADING_JUDGE_CONFIDENCE_FLOOR = 0.5;
