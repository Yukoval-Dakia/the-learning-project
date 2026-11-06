// Versioned estimates for the typed decision lane; chat estimates use catalog rates.

export const ANTHROPIC_SUB_CONTRACT_REF = 'contract:claude-max-subscription/2026-08-02';

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Cache-read input tokens; 0/absent when the endpoint doesn't report cache. */
  cacheReadTokens?: number;
  /** Cache-creation input tokens; 0/absent when the endpoint doesn't report cache. */
  cacheCreationTokens?: number;
}

// YUK-1049 — TypeSafe Jev local pricebook: output tokens are free on the verified
// card (D12 smoke: cost == input_tokens × 4.2e-8). Probed 2026-09-24. A reported
// usage.cost always wins (attempt-cost.ts).

/** USD per token (NOT per-million): prompt 4.2e-8, completion 0. */
export const JEV_INPUT_USD_PER_TOKEN = 0.000000042;
export const JEV_OUTPUT_USD_PER_TOKEN = 0;
/** Provider-bound max_price the typed runner sends (USD per MILLION tokens). */
export const JEV_MAX_PRICE_USD_PER_MILLION = { prompt: '0.042', completion: '0' } as const;
export const JEV_PRICEBOOK_VERSION = '2026-09-24-openrouter-typesafe-jev-v1';
/** Request model id; canonical reported id is asserted at runtime. */
export const JEV_REQUEST_MODEL = 'typesafe/jev-1.13';
export const JEV_CANONICAL_MODEL = 'typesafe/jev-1.13-20260917';

/** The OpenRouter typed decisions model; every other OpenRouter id is a pi chat model. */
export function isJevModel(model: string): boolean {
  return model.startsWith('typesafe/jev');
}

/**
 * Local USD estimate: input tokens × 4.2e-8, output free. Unknown model or
 * non-finite/negative counts ⇒ null (unknown, never zero).
 */
export function jevLocalCostUsd(model: string, tokens: TokenCounts): number | null {
  if (!isJevModel(model)) return null;
  // A real paid call consumes input tokens; usage evidence with inputTokens<=0
  // (or a wholly absent usage block recorded as zeros) is no token evidence —
  // unknown cost, never a fabricated $0.
  if (!Number.isFinite(tokens.inputTokens) || tokens.inputTokens <= 0) return null;
  if (!Number.isFinite(tokens.outputTokens) || tokens.outputTokens < 0) return null;
  return (
    tokens.inputTokens * JEV_INPUT_USD_PER_TOKEN + tokens.outputTokens * JEV_OUTPUT_USD_PER_TOKEN
  );
}

// YUK-359 — GLM chat (memory reconcile) cost in CNY. These rates are PLACEHOLDERS
// pending owner confirmation; the MiMo card does not establish a GLM contract.
const GLM_CHAT_INPUT_PER_M_CNY = 1.0; // PLACEHOLDER — confirm GLM-5.2 input price
const GLM_CHAT_OUTPUT_PER_M_CNY = 3.0; // PLACEHOLDER — confirm GLM-5.2 output price

/** GLM chat cost in CNY 元 from prompt/completion tokens. */
export function glmChatCostCny(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens * GLM_CHAT_INPUT_PER_M_CNY + completionTokens * GLM_CHAT_OUTPUT_PER_M_CNY) /
    1_000_000
  );
}
