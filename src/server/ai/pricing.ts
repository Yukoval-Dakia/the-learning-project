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
// today exactly the mimo-v2.5 pair). The RATES stay here and remain the
// documented placeholder card below.
//
// ⚠️ UNIT PRICES ARE PLACEHOLDERS PENDING OWNER CONFIRMATION (phase-deferred per
// CLAUDE.md "占位代码必须留注释"). mimo is a self-hosted xiaomi endpoint with no
// public SDK/pricing page; these rates must be replaced with the real contracted
// per-token price + an 实测 date comment before the cost numbers are trusted for
// budgeting. The arithmetic SHAPE (per-token-type breakdown) is correct and tested;
// only the magnitude is provisional. Revisit: YUK-359 follow-up / owner pricing input.

import { resolveModelProfile } from './model-profiles';

/** Per-million-token USD unit prices, split by token type. */
interface ModelPricing {
  /** Fresh (non-cached) input tokens, USD per 1M. */
  inputPerM: number;
  /** Output / completion tokens, USD per 1M. */
  outputPerM: number;
  /** Cache-read input tokens, USD per 1M (typically ≪ inputPerM). */
  cacheReadPerM: number;
  /** Cache-creation input tokens, USD per 1M (typically > inputPerM). */
  cacheCreationPerM: number;
}

// PLACEHOLDER rates (USD/1M tokens) — see file header warning. Shape mirrors
// Anthropic-style pricing (cache_read ≈ 0.1×input, cache_creation ≈ 1.25×input,
// output a separate higher rate). Replace magnitudes with real mimo contract.
const MIMO_BASE: ModelPricing = {
  inputPerM: 0.3, // PLACEHOLDER — confirm real mimo input price
  outputPerM: 1.2, // PLACEHOLDER — confirm real mimo output price
  cacheReadPerM: 0.03, // PLACEHOLDER — typically ~0.1× input
  cacheCreationPerM: 0.375, // PLACEHOLDER — typically ~1.25× input
};

/** Version is embedded in every estimate ref so historical rows stay explainable. */
export const ATTEMPT_PRICEBOOK_VERSION = '2026-08-02-placeholder-v1';
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
 * model shares the single placeholder mimo rate card above until the owner
 * confirms real per-model rates.
 */
export function localCostUsd(model: string, tokens: TokenCounts): number | null {
  if (!hasLocalPricing(model)) return null;
  const p = MIMO_BASE;
  const cacheRead = tokens.cacheReadTokens ?? 0;
  const cacheCreation = tokens.cacheCreationTokens ?? 0;
  return (
    (tokens.inputTokens * p.inputPerM +
      tokens.outputTokens * p.outputPerM +
      cacheRead * p.cacheReadPerM +
      cacheCreation * p.cacheCreationPerM) /
    1_000_000
  );
}

// YUK-359 — GLM chat (memory reconcile) cost in RMB (CNY). GLM-5.2 prices in
// 元/M tokens. PLACEHOLDER rate pending owner confirmation (same warning as
// mimo above — GLM coding-plan pricing must be confirmed + 实测 dated before
// trusted for budgeting). Returns CNY 元.
const GLM_CHAT_INPUT_PER_M_CNY = 1.0; // PLACEHOLDER — confirm GLM-5.2 input price
const GLM_CHAT_OUTPUT_PER_M_CNY = 3.0; // PLACEHOLDER — confirm GLM-5.2 output price

/** GLM chat cost in CNY 元 from prompt/completion tokens. */
export function glmChatCostCny(promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens * GLM_CHAT_INPUT_PER_M_CNY + completionTokens * GLM_CHAT_OUTPUT_PER_M_CNY) /
    1_000_000
  );
}
