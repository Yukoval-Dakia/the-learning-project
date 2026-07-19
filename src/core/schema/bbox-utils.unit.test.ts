import { describe, expect, it } from 'vitest';
import { clamp01, clampBBox } from './bbox-utils';

describe('bbox utilities', () => {
  it('clamps normalized coordinates and maps non-finite values to zero', () => {
    expect(clamp01(-0.25)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(1.25)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('caps width and height at the remaining page extent', () => {
    expect(clampBBox({ x: 0.75, y: 0.5, width: 0.75, height: 2 })).toEqual({
      x: 0.75,
      y: 0.5,
      width: 0.25,
      height: 0.5,
    });
  });

  it('leaves an already canonical bbox byte-identical', () => {
    expect(clampBBox({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 })).toEqual({
      x: 0.25,
      y: 0.5,
      width: 0.5,
      height: 0.25,
    });
  });
});
