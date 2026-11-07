// Pre-send input budget for the provider wire (YUK-1776).
//
// The catalog's `maxInputTokens` is an input budget, not the model window. The
// local estimator counts CJK ~1 token/char and other text ~1 token/4 chars, so
// it undercounts JSON-shaped payloads. yuk1984 evidence bounds the bias: echo
// runs imply 1.12–1.14 counting only prompt+payload bytes (≈1.0 once assistant
// turns are included), and the failed TEST run's provider-reported input was
// ≥1.056–1.088× the 328k budget. OpenDesign is the only catalog entry with a
// declared input budget (328k), and its compaction trigger is 85% of it (278.8k),
// so a 1.15 safety factor (285.2k raw estimate) stays above every compacted
// request and only rejects estimates that would already be over budget in fact.
export const CATALOG_INPUT_SAFETY_RATIO = 1.15;

/** Observed provider usage for the previous request in this run. */
export interface PiUsageCalibration {
  estimated: number;
  actual: number;
}

export interface PiInputFitInput {
  estimatedTokens: number;
  contextWindow: number;
  maxInputTokens?: number;
  lastUsage?: PiUsageCalibration;
}

export interface PiInputFit {
  fits: boolean;
  /** Estimated tokens after the safety factor / usage calibration. */
  projectedTokens: number;
  /** Raw estimator output for the request. */
  estimatedTokens: number;
  /** The budget the projection is compared against. */
  budget: number;
  safetyRatio: number;
  reason?: 'over_input_limit' | 'over_context_window';
}

/**
 * Decide whether a provider request is worth sending. Only a declared catalog
 * input budget applies the safety factor; providers without one keep the exact
 * estimator (the model window remainder is the existing backstop).
 */
export function decidePiInputFit(input: PiInputFitInput): PiInputFit {
  const { estimatedTokens, contextWindow, maxInputTokens, lastUsage } = input;
  const ratio =
    lastUsage && lastUsage.estimated > 0 && lastUsage.actual > 0
      ? Math.min(3, Math.max(0.5, lastUsage.actual / lastUsage.estimated))
      : 1;
  const safetyRatio =
    maxInputTokens === undefined ? 1 : Math.max(CATALOG_INPUT_SAFETY_RATIO, ratio);
  const budget = maxInputTokens ?? contextWindow;
  const projectedTokens = Math.ceil(estimatedTokens * safetyRatio);
  const overInput = projectedTokens > budget;
  const overWindow = contextWindow - estimatedTokens <= 0;
  return {
    fits: !overInput && !overWindow,
    projectedTokens,
    estimatedTokens,
    budget,
    safetyRatio,
    ...(overInput
      ? { reason: 'over_input_limit' as const }
      : overWindow
        ? { reason: 'over_context_window' as const }
        : {}),
  };
}
