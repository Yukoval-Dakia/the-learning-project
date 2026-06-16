import { describe, expect, it } from 'vitest';
import { fromSqlVector, toSqlVector } from './vector';

describe('vector customType codec', () => {
  it('serializes number[] to pgvector text literal', () => {
    expect(toSqlVector([0.1, -0.2, 0.3])).toBe('[0.1,-0.2,0.3]');
  });
  it('parses pgvector text literal back to number[]', () => {
    expect(fromSqlVector('[0.1,-0.2,0.3]')).toEqual([0.1, -0.2, 0.3]);
  });
  it('round-trips', () => {
    const v = [0.5, 0, -1.25];
    expect(fromSqlVector(toSqlVector(v))).toEqual(v);
  });
  it('round-trips the empty vector', () => {
    expect(toSqlVector([])).toBe('[]');
    expect(fromSqlVector(toSqlVector([]))).toEqual([]);
  });
  it('round-trips scientific-notation values (full-precision doubles)', () => {
    const v = [5e-7, 1.2345678901234567e-3, -9.87e8];
    expect(fromSqlVector(toSqlVector(v))).toEqual(v);
  });
  it('round-trips the production 1024-length shape', () => {
    const v = Array.from({ length: 1024 }, (_, i) => (i % 2 ? -i : i) / 1000);
    const round = fromSqlVector(toSqlVector(v));
    expect(round).toHaveLength(1024);
    expect(round).toEqual(v);
  });
  it('throws on non-finite elements (NaN / Infinity)', () => {
    expect(() => toSqlVector([1, Number.NaN, 3])).toThrow(/non-finite/);
    expect(() => toSqlVector([Number.POSITIVE_INFINITY])).toThrow(/non-finite/);
  });
});
