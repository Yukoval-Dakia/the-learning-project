// YUK-677 — pure-math unit coverage for the threshold-calibration replay.
//
// audit-threshold-calibration.ts runs loadEnv() at module top (fills empty env only; schema
// validation is skipped under VITEST) and opens its postgres client ONLY inside runCli(), so
// importing this module for the pure helpers touches no Postgres → safe in the unit lane.

import { describe, expect, it } from 'vitest';
import { cosineDistance, fractionUnder, quantile, summarize } from './audit-threshold-calibration';

describe('cosineDistance — pgvector `<=>` semantics (0 same dir .. 2 opposite)', () => {
  it('identical vectors → 0', () => {
    expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0, 12);
  });

  it('scaled vectors → 0 (direction, not magnitude)', () => {
    expect(cosineDistance([1, 0, 0], [5, 0, 0])).toBeCloseTo(0, 12);
  });

  it('orthogonal vectors → 1', () => {
    expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1, 12);
  });

  it('opposite vectors → 2', () => {
    expect(cosineDistance([1, 0], [-1, 0])).toBeCloseTo(2, 12);
  });

  it('known angle: 60° apart → 1 - cos(60°) = 0.5', () => {
    expect(cosineDistance([1, 0], [0.5, Math.sqrt(3) / 2])).toBeCloseTo(0.5, 12);
  });

  it('zero-norm vector → NaN (mirrors pgvector; caller counts + excludes)', () => {
    expect(cosineDistance([0, 0], [1, 0])).toBeNaN();
  });

  it('dim mismatch → throws (programmer error, fails loud)', () => {
    expect(() => cosineDistance([1, 0], [1, 0, 0])).toThrow(/dim mismatch/);
  });
});

describe('quantile — type-7 linear interpolation', () => {
  it('single element → that element', () => {
    expect(quantile([0.4], 0.9)).toBe(0.4);
  });

  it('median of even n averages the middle two', () => {
    expect(quantile([0.1, 0.2, 0.3, 0.4], 0.5)).toBeCloseTo(0.25, 12);
  });

  it('p0 → min, p1 → max', () => {
    const v = [0.1, 0.3, 0.9];
    expect(quantile(v, 0)).toBe(0.1);
    expect(quantile(v, 1)).toBe(0.9);
  });

  it('interpolates between neighbours', () => {
    // idx = 0.25 * 3 = 0.75 → 0.1 + (0.3-0.1)*0.75 = 0.25
    expect(quantile([0.1, 0.3, 0.5, 0.9], 0.25)).toBeCloseTo(0.25, 12);
  });

  it('empty → NaN', () => {
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe('summarize — filters non-finite before sorting', () => {
  it('drops NaN/Infinity and reports n of the clean set', () => {
    const s = summarize([0.2, Number.NaN, 0.8, Number.POSITIVE_INFINITY, 0.5]);
    expect(s.n).toBe(3);
    expect(s.min).toBeCloseTo(0.2, 12);
    expect(s.max).toBeCloseTo(0.8, 12);
    expect(s.p50).toBeCloseTo(0.5, 12);
  });

  it('empty → n=0 and NaN quantiles', () => {
    const s = summarize([]);
    expect(s.n).toBe(0);
    expect(s.p50).toBeNaN();
  });
});

describe('fractionUnder — inclusive ceiling share over sorted input', () => {
  it('counts values <= ceiling', () => {
    expect(fractionUnder([0.1, 0.2, 0.3, 0.4], 0.25)).toBeCloseTo(0.5, 12);
  });

  it('ceiling below min → 0; above max → 1', () => {
    const v = [0.3, 0.4];
    expect(fractionUnder(v, 0.1)).toBe(0);
    expect(fractionUnder(v, 0.9)).toBe(1);
  });

  it('empty → NaN', () => {
    expect(fractionUnder([], 0.5)).toBeNaN();
  });
});
