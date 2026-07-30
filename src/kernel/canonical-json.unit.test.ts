import { describe, expect, it } from 'vitest';
import { sha256CanonicalJson } from './canonical-json';

describe('sha256CanonicalJson', () => {
  it('is independent of nested object key insertion order while preserving array order', () => {
    const left = {
      z: [{ b: 2, a: 1 }, 'tail'],
      a: { y: true, x: null },
    };
    const right = {
      a: { x: null, y: true },
      z: [{ a: 1, b: 2 }, 'tail'],
    };
    expect(sha256CanonicalJson(left)).toBe(sha256CanonicalJson(right));
    expect(sha256CanonicalJson({ values: [1, 2] })).not.toBe(
      sha256CanonicalJson({ values: [2, 1] }),
    );
  });
});
