import { describe, expect, it } from 'vitest';
import { hasLocalPricing, localCostUsd } from './pricing';

function knownCost(model: string, inputTokens: number, outputTokens: number): number {
  const cost = localCostUsd(model, { inputTokens, outputTokens });
  if (cost === null) throw new Error(`expected ${model} to have a pricebook entry`);
  return cost;
}

describe('localCostUsd', () => {
  it('returns null for an unknown model instead of fabricating free usage', () => {
    expect(
      localCostUsd('definitely-not-a-real-model', { inputTokens: 1000, outputTokens: 1000 }),
    ).toBeNull();
  });

  // YUK-924 site 5 — pricebook membership is now the xiaomi provider binding's
  // execution.localPricebook flag (exactly the mimo-v2.5 pair), not a local
  // model-id set. Characterization: the membership boundary is byte-identical.
  it('derives pricebook membership from the model-profile registry (mimo pair only)', () => {
    expect(hasLocalPricing('mimo-v2.5')).toBe(true);
    expect(hasLocalPricing('mimo-v2.5-pro')).toBe(true);
    // Other xiaomi catalog models, other providers' models, unknown ids: no
    // local pricebook (attempt-cost classifies them as basis 'unknown').
    expect(hasLocalPricing('mimo-v2-flash')).toBe(false);
    expect(hasLocalPricing('glm-5.2')).toBe(false);
    expect(hasLocalPricing('glm-5.3-flash')).toBe(false);
    expect(hasLocalPricing('claude-opus-4-8')).toBe(false);
    expect(hasLocalPricing('definitely-not-a-real-model')).toBe(false);
  });

  it('scales known mimo input and output buckets independently', () => {
    const one = knownCost('mimo-v2.5-pro', 1000, 0);
    const two = knownCost('mimo-v2.5-pro', 2000, 0);
    const output = knownCost('mimo-v2.5-pro', 0, 1000);

    expect(one).toBeGreaterThan(0);
    expect(two).toBeCloseTo(one * 2, 10);
    expect(output).toBeGreaterThan(one);
    expect(knownCost('mimo-v2.5-pro', 1000, 1000)).toBeCloseTo(one + output, 10);
  });

  it('prices cache reads below fresh input and treats absent cache fields as zero', () => {
    const freshInput = knownCost('mimo-v2.5', 1000, 0);
    const cachedInput = localCostUsd('mimo-v2.5', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
    });
    const withoutCache = knownCost('mimo-v2.5', 500, 500);
    const withZeroCache = localCostUsd('mimo-v2.5', {
      inputTokens: 500,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });

    expect(cachedInput).not.toBeNull();
    expect(cachedInput ?? 0).toBeGreaterThan(0);
    expect(cachedInput ?? Number.POSITIVE_INFINITY).toBeLessThan(freshInput);
    expect(withZeroCache).toBe(withoutCache);
  });
});
