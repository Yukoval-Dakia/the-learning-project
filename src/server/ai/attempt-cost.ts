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
 * evidence. Compatibility endpoints commonly emit placeholder zero, so they
 * need a positive SDK amount or an explicit pricebook/contract estimate.
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

  const reported = input.reportedCostUsd;
  const hasTrustworthyReportedAmount =
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
