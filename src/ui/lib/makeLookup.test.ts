import { describe, expect, it } from 'vitest';
import { makeLookup } from './makeLookup';

describe('makeLookup', () => {
  it('returns mapped values and a stable fallback for unknown keys', () => {
    const fallback = { label: '其它来源' };
    const lookup = makeLookup({ manual: { label: '手动录入' } }, fallback);

    expect(lookup('manual')).toEqual({ label: '手动录入' });
    expect(lookup('future_source')).toBe(fallback);
  });

  it('preserves defined falsy values instead of replacing them', () => {
    const lookup = makeLookup({ zero: 0, empty: 0 }, 1);

    expect(lookup('zero')).toBe(0);
    expect(lookup('missing')).toBe(1);
  });
});
