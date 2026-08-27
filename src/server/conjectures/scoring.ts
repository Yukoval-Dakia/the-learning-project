// ADR-0046: proper-scoring = Rust-first single-source-of-truth. This TS is a PLACEHOLDER
// stub — bit-exact replacement lands with the Rust calibration kernel
// (crates/calibration-native). REGISTERED under the ADR-0046 exemption inventory (owner
// 2026-08-27, YUK-679 LIGHT) — see 「豁免登记」 R1 in
// docs/adr/0046-rust-numerical-engine-single-source-of-truth.md: the placeholder intent
// STANDS, now tracked with an explicit port trigger instead of an unowned promise.
// Pure 3-scalar → 4-scalar, no DB / no cohort = structurally
// n=1-safe (DROP-7 clean). The window-aggregate "beats baseline" remains Rust-owned
// + deferred. YUK-795 now consumes the sign of this single-point score in a named
// two-observation ordinal streak rule for conjecture ranking; it still never moves
// mastery, typed-state, or FSRS.

export interface PredictionScore {
  /** (predicted − outcome)² — the model's Brier loss for this single probe. */
  brierModel: number;
  /** (baseline − outcome)² — the quantitative baseline's Brier loss. */
  brierBaseline: number;
  /** −[y·ln p + (1−y)·ln(1−p)] — model log loss (ε-clamped). */
  logLossModel: number;
  /** 1 − BS_model/BS_baseline at THIS point (degenerate; real skill = window aggregate). */
  skillScorePoint: number;
}

const EPS = 1e-9;

function clamp01(x: number): number {
  // Guard NaN/±Infinity → 0 so a degenerate input never poisons every output with NaN
  // (Math.min/max propagate NaN). Keeps the stub structurally n=1-safe under any input.
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0;
}

/**
 * Score one probe outcome against the conjecture's predicted_p and the quantitative
 * baseline_p. `outcome` is 1 (answered correctly) or 0 (wrong). All outputs are
 * single-point; the HONEST "beats baseline" is the window mean
 * `1 − mean(BS_model)/mean(BS_baseline)` — Rust-owned + DEFERRED (ADR-0046). The reconcile
 * loop appends these to a prediction_score event; the accountability reader consumes
 * their sign for conjecture ordering but never flips a typed_state label.
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
  // ε-clamp p away from {0,1} so log loss never hits ±Infinity at a degenerate prediction.
  const pc = Math.min(1 - EPS, Math.max(EPS, p));
  const logLossModel = -(outcome * Math.log(pc) + (1 - outcome) * Math.log(1 - pc));
  // 0 when the baseline is already perfect (BS_baseline = 0 — nothing to improve on);
  // else 1 − BS_model/BS_baseline (>0 ⇒ the model beat the baseline at this point).
  const skillScorePoint = brierBaseline === 0 ? 0 : 1 - brierModel / brierBaseline;
  return { brierModel, brierBaseline, logLossModel, skillScorePoint };
}
