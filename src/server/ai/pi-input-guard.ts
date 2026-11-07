// Pre-send input budget for the provider wire (YUK-1776).
//
// The catalog's `maxInputTokens` is an input budget, not the model window, and
// the local estimator undercounts JSON-shaped payloads (CJK ~1 token/char,
// other text ~1 token/4 chars vs the provider's ~3). Whether to pre-emptively
// block on that budget is a per-route policy decision carried as a catalog
// override fact (`input_safety_ratio`), not a global constant and not an
// upstream capability: a route declares it only when estimator↔provider
// reconciliation exists. Today that is opencode-go/deepseek-v4.1-flash alone —
// a policy margin of 1.15 set just outside the yuk1984-observed bias band
// (≈1.0–1.14). Models without the declaration see exactly the legacy
// context-window check and nothing else.
//
// Within a run the margin rises to the measured actual/estimate ratio once a
// response reports usage — the first request has no calibration, so a miss on
// request one is overspend the catalog budget absorbs, never a wrong block.

/** Observed provider usage for the previous request in this run. */
export interface PiUsageCalibration {
  estimated: number;
  actual: number;
}

/**
 * The pre-send guard rejected a request before anything reached the provider:
 * zero tokens could have been consumed, so usage accounting must not bill an
 * estimate for it. Detected by marker property rather than instanceof so the
 * signal survives error wrapping between the wire and the runner.
 */
export class PiInputBudgetRejectedError extends Error {
  readonly piInputBudgetRejected = true;
}

export function isPiInputBudgetRejected(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { piInputBudgetRejected?: unknown }).piInputBudgetRejected === true
  );
}

export interface PiInputFitInput {
  estimatedTokens: number;
  contextWindow: number;
  maxInputTokens?: number;
  /** Declared pre-send margin for this route (catalog override fact). Without
   *  it no input budget is enforced, whatever `maxInputTokens` says. */
  inputSafetyRatio?: number;
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
 * Decide whether a provider request is worth sending. The input-budget check
 * runs only where the route declares `inputSafetyRatio`; the context-window
 * floor is the unchanged legacy backstop for every model.
 */
export function decidePiInputFit(input: PiInputFitInput): PiInputFit {
  const { estimatedTokens, contextWindow, maxInputTokens, inputSafetyRatio, lastUsage } = input;
  const measured =
    lastUsage && lastUsage.estimated > 0 && lastUsage.actual > 0
      ? Math.min(3, Math.max(0.5, lastUsage.actual / lastUsage.estimated))
      : 1;
  const enforcesInputBudget = inputSafetyRatio !== undefined;
  const safetyRatio = enforcesInputBudget ? Math.max(inputSafetyRatio, measured) : 1;
  const budget = maxInputTokens ?? contextWindow;
  const projectedTokens = Math.ceil(estimatedTokens * safetyRatio);
  const overInput = enforcesInputBudget && projectedTokens > budget;
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
