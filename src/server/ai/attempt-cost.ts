import type { Provider } from '@/ai/registry';
import {
  ANTHROPIC_SUB_CONTRACT_REF,
  ATTEMPT_PRICEBOOK_VERSION,
  type TokenCounts,
  hasLocalPricing,
  localCostUsd,
} from './pricing';

/** The one semantic cost truth owned by a central-runner model attempt. */
export type AttemptCostTruth =
  | { basis: 'reported'; amountUsd: number; ref: string }
  | { basis: 'estimated'; amountUsd: number; ref: string }
  | { basis: 'unknown'; amountUsd: null; ref: string };

export type AttemptCostBasis = AttemptCostTruth['basis'];

export function unknownAttemptCostTruth(provider: string, model: string): AttemptCostTruth {
  return { basis: 'unknown', amountUsd: null, ref: `unpriced:${provider}/${model}` };
}

/**
 * Classify one attempt without turning "unpriced" into numeric zero.
 *
 * Anthropic direct is the only lane where SDK-reported zero is contractual
 * evidence. MiMo SDK USD totals are derived from SDK fallback prices, even
 * when positive: use the explicit local estimate, never call them an invoice.
 * Other compatibility-lane policy remains unchanged in this bounded correction.
 */
export function resolveAttemptCostTruth(input: {
  provider: Provider;
  model: string;
  tokens: TokenCounts;
  reportedCostUsd?: number;
}): AttemptCostTruth {
  if (input.provider === 'anthropic-sub') {
    return {
      basis: 'estimated',
      amountUsd: 0,
      ref: ANTHROPIC_SUB_CONTRACT_REF,
    };
  }

  // YUK-921 P1 + YUK-1027 — pi-catalog lanes (opencode-go, openai):
  // `usage.cost` is the pi catalog's rate-card estimate surfaced through the
  // same reported channel. It is NOT a contractual invoice (subscription lane;
  // OpenAI's real price/tier math is P2 scope) — classify 'estimated' and
  // point the ref at the catalog/model pair the number came from. Without a
  // pi usage record the lane has no honest price → unknown rather than a
  // fabricated zero.
  if (input.provider === 'opencode-go' || input.provider === 'openai') {
    const reported = input.reportedCostUsd;
    if (reported !== undefined && Number.isFinite(reported) && reported >= 0) {
      return {
        basis: 'estimated',
        amountUsd: reported,
        ref: `pi-catalog:${input.provider}/${input.model}`,
      };
    }
    return unknownAttemptCostTruth(input.provider, input.model);
  }

  const reported = input.reportedCostUsd;
  const hasTrustworthyReportedAmount =
    input.provider !== 'xiaomi' &&
    reported !== undefined &&
    Number.isFinite(reported) &&
    reported >= 0 &&
    (input.provider === 'anthropic' || reported > 0);
  if (hasTrustworthyReportedAmount) {
    return { basis: 'reported', amountUsd: reported, ref: 'sdk:total_cost_usd' };
  }

  const estimated = localCostUsd(input.model, input.tokens);
  if (
    input.provider === 'xiaomi' &&
    hasLocalPricing(input.model) &&
    estimated !== null &&
    Number.isFinite(estimated) &&
    estimated >= 0
  ) {
    return {
      basis: 'estimated',
      amountUsd: estimated,
      ref: `pricebook:${ATTEMPT_PRICEBOOK_VERSION}/${input.provider}/${input.model}`,
    };
  }

  return unknownAttemptCostTruth(input.provider, input.model);
}
