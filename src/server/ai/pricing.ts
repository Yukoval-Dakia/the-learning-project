// YUK-359 / YUK-841 — versioned local estimate for endpoints that don't expose
// trustworthy total_cost_usd. The amount and its basis must travel together;
// zero is never used as a synonym for "unknown".
//
// The xiaomi/mimo endpoint does NOT return SDKResultSuccess.total_cost_usd (see
// runner.ts comment), so cost_ledger.cost was hardcoded to 0 for ~99% of calls.
// This module computes USD cost locally from token counts × per-model unit price,
// mirroring the GLM-OCR precedent (tencent_ocr_extract.ts calculateGlmOcrCost:
// module-local function + hardcoded rate + comment).
//
// Unknown models are classified as { basis:'unknown', amountUsd:null } by the
// attempt-cost module. localCostUsd() remains the arithmetic primitive for
// known pricebook entries only.
//
// YUK-924 site 5 — WHICH models carry a local pricebook is no longer a
// module-local model-id set: membership derives from the ModelProfile registry
// (`execution.localPricebook` on the xiaomi provider binding in providers.ts —
// today exactly the mimo-v2.5 pair). Rates are reused from the committed catalog.
//
// YUK-964: public overseas USD rates checked2026-09-06 against
// https://mimo.mi.com/docs/en-US/price/pay-as-you-go (updated2026-08-06).
// Reuse the committed model catalog, whose MiMo rates match the official card;
// do not maintain a second numeric card. These are estimates, not an account
// invoice or a claim about a domestic CNY contract. Historical ledgers are untouched.

import modelCatalog from './model-catalog.snapshot.json' with { type: 'json' };
import { resolveModelProfile } from './model-profiles';

/** Per-million-token USD unit prices, split by token type. */
const MIMO_PRICES = {
  'mimo-v2.5': modelCatalog.providers.xiaomi.models['mimo-v2.5'].cost,
  'mimo-v2.5-pro': modelCatalog.providers.xiaomi.models['mimo-v2.5-pro'].cost,
};

/** Version is embedded in every estimate ref so historical rows stay explainable. */
export const ATTEMPT_PRICEBOOK_VERSION = '2026-09-06-mimo-public-usd-v2';
export const ANTHROPIC_SUB_CONTRACT_REF = 'contract:claude-max-subscription/2026-08-02';

/**
 * Does this model carry the local USD token pricebook? Membership is the
 * xiaomi provider binding's `execution.localPricebook` flag (ModelProfile
 * registry, YUK-924 site 5) — the pricebook exists precisely for the xiaomi
 * lane whose endpoint reports no cost; attempt-cost gates on provider ===
 * 'xiaomi' around it, so the xiaomi scoping loses nothing.
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
 * Compute USD cost for a model run from token counts. Unknown model → null.
 * Cache fields default to 0 (mimo may not report them; arithmetic degrades to
 * input+output two-bucket pricing, semantics intact). Every locally priced
 * model uses its own catalog rate. Cache creation is currently free on the
 * official public card; the version above pins that time-limited policy.
 */
export function localCostUsd(model: string, tokens: TokenCounts): number | null {
  if (!hasLocalPricing(model)) return null;
  if (model !== 'mimo-v2.5' && model !== 'mimo-v2.5-pro') return null;
  const p = MIMO_PRICES[model];
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

// YUK-359 — GLM chat (memory reconcile) cost in RMB (CNY). GLM-5.2 prices in
// 元/M tokens. This separate GLM PLACEHOLDER remains pending owner confirmation;
// the MiMo public-card update does not establish a GLM coding-plan contract.
// Returns CNY 元.
const GLM_CHAT_INPUT_PER_M_CNY = 1.0; // PLACEHOLDER — confirm GLM-5.2 input price
const GLM_CHAT_OUTPUT_PER_M_CNY = 3.0; // PLACEHOLDER — confirm GLM-5.2 output price

/** GLM chat cost in CNY 元 from prompt/completion tokens. */
export function glmChatCostCny(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens * GLM_CHAT_INPUT_PER_M_CNY + completionTokens * GLM_CHAT_OUTPUT_PER_M_CNY) /
    1_000_000
  );
}
