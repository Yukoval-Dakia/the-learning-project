import type { TokenCounts } from './pricing';

/**
 * USD for estimated tokens using the same pi catalog card that prices a
 * finished run's `usage.cost`. Xiaomi Token Plan entries are copies of the
 * xiaomi card, so they resolve there. No card → null, never a fabricated 0.
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
  if (!model) return null;
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
