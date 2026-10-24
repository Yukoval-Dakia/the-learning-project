// YUK-359 / YUK-841 — versioned local estimate for endpoints that do not expose
// a trustworthy total_cost_usd. Amount and basis travel together; zero is never a
// synonym for "unknown".
//
// The xiaomi/mimo endpoint reports no total_cost_usd, so this module computes USD
// from token counts × per-model unit price and classifies unknown models as
// {basis:'unknown', amountUsd:null} (attempt-cost.ts). Which models carry a local
// pricebook derives from the ModelProfile registry (`execution.localPricebook`);
// rates come from the runtime catalog, cache first, else the committed snapshot.
//
// YUK-964: public overseas USD rates checked 2026-09-06 against the official MiMo
// card. These are estimates, not an invoice or a claim about a CNY contract.

import { catalogModelCost } from './model-catalog';
import { resolveModelProfile } from './model-profiles';

/** Version is embedded in every estimate ref so historical rows stay explainable. */
export const ATTEMPT_PRICEBOOK_VERSION = '2026-09-06-mimo-public-usd-v2';
export const ANTHROPIC_SUB_CONTRACT_REF = 'contract:claude-max-subscription/2026-08-02';

/**
 * Membership is the xiaomi provider binding's `execution.localPricebook` flag
 * (YUK-924 site 5) — the pricebook exists because that endpoint reports no cost.
 */
export function hasLocalPricing(model: string): boolean {
  return resolveModelProfile('xiaomi', model).execution.localPricebook === true;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Cache-read input tokens; 0/absent when the endpoint doesn't report cache. */
  cacheReadTokens?: number;
  /** Cache-creation input tokens; 0/absent when the endpoint doesn't report cache. */
  cacheCreationTokens?: number;
}

/**
 * USD cost from token counts; unknown model → null. Cache fields default to 0, so
 * arithmetic degrades to input+output pricing with semantics intact. Cache creation
 * is free on the pinned card (ATTEMPT_PRICEBOOK_VERSION), which is why only
 * cache-read is priced.
 */
export function localCostUsd(model: string, tokens: TokenCounts): number | null {
  if (!hasLocalPricing(model)) return null;
  if (model !== 'mimo-v2.5' && model !== 'mimo-v2.5-pro') return null;
  const p = catalogModelCost('xiaomi', model);
  if (!p) return null;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheCreation = tokens.cacheCreationTokens ?? 0;
  if (
    [tokens.inputTokens, tokens.outputTokens, cacheRead, cacheCreation].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    return null;
  return (
    (tokens.inputTokens * p.input + tokens.outputTokens * p.output + cacheRead * p.cache_read) /
    1_000_000
  );
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

/**
 * Local USD estimate: input tokens × 4.2e-8, output free. Unknown model or
 * non-finite/negative counts ⇒ null (unknown, never zero).
 */
export function jevLocalCostUsd(model: string, tokens: TokenCounts): number | null {
  if (!model.startsWith('typesafe/jev')) return null;
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
