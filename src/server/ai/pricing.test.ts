import { describe, expect, it } from 'vitest';
import { localCostUsd } from './pricing';

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
