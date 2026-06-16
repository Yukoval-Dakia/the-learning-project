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
});
