// Placeholder for the Rust calibration kernel in crates/calibration-native.
// Three scalars in, four scalars out. No database read and no cohort, so it cannot fit a learner.
// The window mean that would honestly say "beats baseline" stays in Rust (ADR-0046).
// Callers may use the sign of this single probe. This function never writes mastery, typed state, or FSRS.

export interface PredictionScore {
  /** Squared error of the conjecture on this probe. */
  brierModel: number;
  /** Squared error of the quantitative baseline on this probe. */
  brierBaseline: number;
  /** Log loss of the conjecture on this probe, clamped off 0 and 1. */
  logLossModel: number;
  /** Single-probe skill. The honest skill score is the Rust window mean. */
  skillScorePoint: number;
}

const EPS = 1e-9;

function clamp01(x: number): number {
  // Math.min and Math.max propagate NaN. A non-finite input must not poison every output.
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/**
 * Score one probe. `outcome` is 1 when the answer is correct.
 * A positive skill score means this probe beat the baseline. The window mean stays in Rust.
 */
export function scorePrediction(
  predicted: number,
  baseline: number,
  outcome: 0 | 1,
): PredictionScore {
  const p = clamp01(predicted);
  const b = clamp01(baseline);
  const brierModel = (p - outcome) ** 2;
  const brierBaseline = (b - outcome) ** 2;
  // Log loss is infinite at 0 and 1.
  const pc = Math.min(1 - EPS, Math.max(EPS, p));
  const logLossModel = -(outcome * Math.log(pc) + (1 - outcome) * Math.log(1 - pc));
  // A perfect baseline leaves nothing to beat, so the skill score is 0 rather than a division by zero.
  const skillScorePoint = brierBaseline === 0 ? 0 : 1 - brierModel / brierBaseline;
  return { brierModel, brierBaseline, logLossModel, skillScorePoint };
}
