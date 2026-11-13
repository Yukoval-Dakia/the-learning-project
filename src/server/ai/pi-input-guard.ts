// Pre-send input budget for the provider wire (YUK-1776).
//
// The catalog's `maxInputTokens` is an input budget, not the model window, and
// the local estimator undercounts JSON-shaped payloads (CJK ~1 token/char,
// other text ~1 token/4 chars vs the provider's ~3). Every model keeps the
// legacy check — `estimate > (maxInputTokens ?? contextWindow)` — unchanged.
// Multiplying the estimate by a safety ratio is a per-route policy decision
// carried as a catalog override fact (`input_safety_ratio`), applied only
// where estimator↔provider reconciliation exists: deepseek-v4.1-flash on both
// opencode-go and custom:opendesign (yuk1984 runs cover both), margin 1.15 set
// just outside the observed ≈1.0–1.14 bias band. Routes serving the same model
// without a stored declaration (e.g. a custom bucket persisted before the fact
// existed, pending the next /models refresh) fall back to the legacy check —
// never blocked earlier than main, never blocked later than it either.
//
// Within a run the margin rises to the measured actual/estimate ratio once a
// response reports usage — the first request has no calibration, so a miss on
// request one is overspend the catalog budget absorbs, never a wrong block.

/** Observed provider usage for the previous request in this run. */
export interface PiUsageCalibration {
  estimated: number;
  actual: number;
}

/** The pre-send guard refused a request before any fetch ran: nothing could
 *  have been billed. The fact is recorded on the transport collector
 *  (`pre_send_rejections`) at throw time — do not rely on this class reaching
 *  the runner intact, pi-ai wraps provider errors into message strings. */
export class PiInputBudgetRejectedError extends Error {}

export interface PiInputFitInput {
  estimatedTokens: number;
  contextWindow: number;
  maxInputTokens?: number;
  /** Declared pre-send margin for this route (catalog override fact). Without
   *  it the check is byte-identical to the legacy estimate-vs-budget rule. */
  inputSafetyRatio?: number;
  lastUsage?: PiUsageCalibration;
}

export interface PiInputFit {
  fits: boolean;
  estimatedTokens: number;
  projectedTokens: number;
  safetyRatio: number;
  budget: number;
  reason?: 'catalog-input-budget' | 'context-window';
}

/**
 * Decide whether a provider request is worth sending. `projectedTokens` is the
 * estimate times the declared margin (1 otherwise); the budget comparison is
 * main's rule for every model, stricter only where a ratio is declared. The
 * context-window floor is the unchanged legacy backstop.
 */
export function decidePiInputFit(input: PiInputFitInput): PiInputFit {
  const { estimatedTokens, contextWindow, maxInputTokens, inputSafetyRatio, lastUsage } = input;
  const measured =
    lastUsage && lastUsage.estimated > 0 && lastUsage.actual > 0
      ? Math.min(3, Math.max(0.5, lastUsage.actual / lastUsage.estimated))
      : 1;
  const safetyRatio = inputSafetyRatio === undefined ? 1 : Math.max(inputSafetyRatio, measured);
  const budget = maxInputTokens ?? contextWindow;
  const projectedTokens = Math.ceil(estimatedTokens * safetyRatio);
  const overInput = projectedTokens > budget;
  const overWindow = contextWindow - estimatedTokens <= 0;
  return {
    fits: !overInput && !overWindow,
    estimatedTokens,
    projectedTokens,
    safetyRatio,
    budget,
    reason: overWindow ? 'context-window' : overInput ? 'catalog-input-budget' : undefined,
  };
}
