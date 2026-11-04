import { catalogModelCost } from './model-catalog';
import type { TokenCounts } from './pricing';

/**
 * USD for estimated tokens using the same pi catalog card that prices a finished
 * run. Token Plan entries copy the xiaomi card. No card → null, never a fake 0.
 */
export async function piCatalogCostUsd(
  provider: string,
  modelId: string,
  tokens: TokenCounts,
): Promise<number | null> {
  if (
    [
      tokens.inputTokens,
      tokens.outputTokens,
      tokens.cacheReadTokens ?? 0,
      tokens.cacheCreationTokens ?? 0,
    ].some((value) => !Number.isFinite(value) || value < 0)
  ) {
    return null;
  }
  const { builtinModels } = await import('@earendil-works/pi-ai/providers/all');
  const { calculateCost } = await import('@earendil-works/pi-ai/models');
  const catalogProvider = provider === 'xiaomi-token-plan' ? 'xiaomi' : provider;
  const model = builtinModels().getModel(catalogProvider, modelId);
  // Preserved ids (e.g. token-plan mimo-v2.5*) are absent from pi's builtin
  // catalog — price them on the models.dev card, the same source a finished
  // run's estimate uses.
  if (!model) {
    const rates = catalogModelCost(catalogProvider, modelId);
    if (!rates) return null;
    const total =
      tokens.inputTokens * rates.input +
      tokens.outputTokens * rates.output +
      (tokens.cacheReadTokens ?? 0) * rates.cache_read +
      (tokens.cacheCreationTokens ?? 0) * (rates.cache_write ?? 0);
    return Number.isFinite(total) && total >= 0 ? total / 1_000_000 : null;
  }
  const cost = calculateCost(model, {
    input: tokens.inputTokens,
    output: tokens.outputTokens,
    cacheRead: tokens.cacheReadTokens ?? 0,
    cacheWrite: tokens.cacheCreationTokens ?? 0,
    totalTokens: tokens.inputTokens + tokens.outputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  return Number.isFinite(cost.total) && cost.total >= 0 ? cost.total : null;
}
