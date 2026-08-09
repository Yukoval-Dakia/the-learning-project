import { costUsdToMicroUsd, sumAllKnownCostUsd } from '@/server/ai/provenance';
import { describe, expect, it } from 'vitest';

describe('all-known product-operation cost', () => {
  it('returns zero for an operation with no child calls', () => {
    expect(sumAllKnownCostUsd([])).toBe(0);
  });

  it('sums numeric children including genuine zero', () => {
    expect(sumAllKnownCostUsd([0, 0.01, 0.02])).toBeCloseTo(0.03, 8);
  });

  it.each([[null], [undefined], [0.01, null, 0.02]])(
    'returns unknown when any attempted child is unpriced',
    (costs) => {
      expect(sumAllKnownCostUsd(costs)).toBeNull();
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'returns unknown when a child reports non-finite cost %s',
    (cost) => {
      expect(sumAllKnownCostUsd([0.01, cost])).toBeNull();
    },
  );

  it('returns unknown when finite children overflow the aggregate', () => {
    expect(sumAllKnownCostUsd([Number.MAX_VALUE, Number.MAX_VALUE])).toBeNull();
  });

  it('converts nullable USD without fabricating micro-USD zero', () => {
    expect(costUsdToMicroUsd(null)).toBeNull();
    expect(costUsdToMicroUsd(undefined)).toBeNull();
    expect(costUsdToMicroUsd(0)).toBe(0);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'converts non-finite USD %s to unknown',
    (cost) => {
      expect(costUsdToMicroUsd(cost)).toBeNull();
    },
  );
});
