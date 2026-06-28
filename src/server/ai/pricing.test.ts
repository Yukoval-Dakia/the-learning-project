import { describe, expect, it } from 'vitest';
import { bailianEmbedCostCny, effectiveCostUsd, glmChatCostCny, localCostUsd } from './pricing';

// YUK-359 — mimo local cost fallback. mimo endpoint does not surface
// total_cost_usd, so runner falls back to token×unit-price. These tests pin the
// arithmetic shape + the per-token-type breakdown, NOT the exact unit prices
// (those are owner-confirmed constants in pricing.ts, revisit when mimo pricing
// changes).
describe('localCostUsd', () => {
  it('returns 0 for an unknown model (no guessing — degrade to 0)', () => {
    expect(
      localCostUsd('definitely-not-a-real-model', {
        inputTokens: 1000,
        outputTokens: 1000,
      }),
    ).toBe(0);
  });

  it('scales linearly with input + output tokens for a known mimo model', () => {
    const one = localCostUsd('mimo-v2.5-pro', { inputTokens: 1000, outputTokens: 0 });
    const two = localCostUsd('mimo-v2.5-pro', { inputTokens: 2000, outputTokens: 0 });
    expect(one).toBeGreaterThan(0);
    expect(two).toBeCloseTo(one * 2, 10);
  });

  it('charges output tokens at a (typically higher) separate rate', () => {
    const inputOnly = localCostUsd('mimo-v2.5-pro', { inputTokens: 1000, outputTokens: 0 });
    const outputOnly = localCostUsd('mimo-v2.5-pro', { inputTokens: 0, outputTokens: 1000 });
    expect(inputOnly).toBeGreaterThan(0);
    expect(outputOnly).toBeGreaterThan(0);
    // input and output are priced independently (not the same bucket).
    expect(localCostUsd('mimo-v2.5-pro', { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(
      inputOnly + outputOnly,
      10,
    );
  });

  it('prices cache_read below fresh input when the field is present', () => {
    const freshInput = localCostUsd('mimo-v2.5-pro', { inputTokens: 1000, outputTokens: 0 });
    const cachedInput = localCostUsd('mimo-v2.5-pro', {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1000,
    });
    expect(cachedInput).toBeGreaterThan(0);
    expect(cachedInput).toBeLessThan(freshInput);
  });

  it('treats absent cache fields as zero (mimo may not report them)', () => {
    const withoutCache = localCostUsd('mimo-v2.5', { inputTokens: 500, outputTokens: 500 });
    const withZeroCache = localCostUsd('mimo-v2.5', {
      inputTokens: 500,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
    expect(withoutCache).toBe(withZeroCache);
  });

  it('supports both mimo model ids', () => {
    expect(localCostUsd('mimo-v2.5', { inputTokens: 1000, outputTokens: 1000 })).toBeGreaterThan(0);
    expect(
      localCostUsd('mimo-v2.5-pro', { inputTokens: 1000, outputTokens: 1000 }),
    ).toBeGreaterThan(0);
  });
});

describe('effectiveCostUsd', () => {
  const tokens = { inputTokens: 1000, outputTokens: 1000 };

  it('uses the reported cost when the endpoint surfaces one (> 0)', () => {
    expect(effectiveCostUsd('mimo-v2.5-pro', tokens, 0.42)).toBe(0.42);
  });

  it('falls back to local price when reported cost is undefined (mimo)', () => {
    expect(effectiveCostUsd('mimo-v2.5-pro', tokens, undefined)).toBe(
      localCostUsd('mimo-v2.5-pro', tokens),
    );
  });

  it('falls back to local price when reported cost is 0 (mimo always 0)', () => {
    expect(effectiveCostUsd('mimo-v2.5-pro', tokens, 0)).toBe(
      localCostUsd('mimo-v2.5-pro', tokens),
    );
  });

  it('returns 0 when reported is 0/undefined AND model is unknown', () => {
    expect(effectiveCostUsd('unknown-model', tokens, undefined)).toBe(0);
    expect(effectiveCostUsd('unknown-model', tokens, 0)).toBe(0);
  });
});

describe('glmChatCostCny', () => {
  it('scales linearly with prompt + completion tokens', () => {
    const one = glmChatCostCny(1_000_000, 0);
    const two = glmChatCostCny(2_000_000, 0);
    expect(one).toBeGreaterThan(0);
    expect(two).toBeCloseTo(one * 2, 10);
  });
});

describe('bailianEmbedCostCny', () => {
  it('scales linearly with prompt tokens (no completion bucket)', () => {
    const one = bailianEmbedCostCny(1_000_000);
    const two = bailianEmbedCostCny(2_000_000);
    expect(one).toBeGreaterThan(0);
    expect(two).toBeCloseTo(one * 2, 10);
  });
});
