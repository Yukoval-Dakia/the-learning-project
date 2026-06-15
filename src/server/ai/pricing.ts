// YUK-359 — local cost fallback for endpoints that don't surface total_cost_usd.
//
// The xiaomi/mimo endpoint does NOT return SDKResultSuccess.total_cost_usd (see
// runner.ts comment), so cost_ledger.cost was hardcoded to 0 for ~99% of calls.
// This module computes USD cost locally from token counts × per-model unit price,
// mirroring the GLM-OCR precedent (tencent_ocr_extract.ts calculateGlmOcrCost:
// module-local function + hardcoded rate + comment).
//
// Returns USD. Unknown models → 0 (no guessing; an unpriced model is observably
// 0, not a fabricated number — consistent with the project's evidence-first line).
//
// ⚠️ UNIT PRICES ARE PLACEHOLDERS PENDING OWNER CONFIRMATION (phase-deferred per
// CLAUDE.md "占位代码必须留注释"). mimo is a self-hosted xiaomi endpoint with no
// public SDK/pricing page; these rates must be replaced with the real contracted
// per-token price + an 实测 date comment before the cost numbers are trusted for
// budgeting. The arithmetic SHAPE (per-token-type breakdown) is correct and tested;
// only the magnitude is provisional. Revisit: YUK-359 follow-up / owner pricing input.

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

// Only the two mimo model ids actually hit at runtime (registry resolves every
// task to one of these; anthropic is wired but no task uses it in production).
const PRICING_BY_MODEL: Record<string, ModelPricing> = {
  'mimo-v2.5': MIMO_BASE,
  'mimo-v2.5-pro': MIMO_BASE,
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Cache-read input tokens; 0/absent when the endpoint doesn't report cache. */
  cacheReadTokens?: number;
  /** Cache-creation input tokens; 0/absent when the endpoint doesn't report cache. */
  cacheCreationTokens?: number;
}

/**
 * Compute USD cost for a model run from token counts. Unknown model → 0.
 * Cache fields default to 0 (mimo may not report them; arithmetic degrades to
 * input+output two-bucket pricing, semantics intact).
 */
export function localCostUsd(model: string, tokens: TokenCounts): number {
  const p = PRICING_BY_MODEL[model];
  if (!p) return 0;
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

/**
 * The cost to record in cost_ledger (USD): trust the endpoint's reported cost
 * when it surfaces one (> 0), else fall back to local token×price. This is the
 * runner's single decision point — mimo reports 0/undefined → local fallback;
 * an endpoint that does report (e.g. real Anthropic) → its number wins.
 */
export function effectiveCostUsd(
  model: string,
  tokens: TokenCounts,
  reportedCostUsd: number | undefined,
): number {
  if (reportedCostUsd != null && reportedCostUsd > 0) return reportedCostUsd;
  return localCostUsd(model, tokens);
}
