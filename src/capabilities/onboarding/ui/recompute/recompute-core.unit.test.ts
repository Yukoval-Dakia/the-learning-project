// YUK-495 S5 #41 — UI verdict layer (deriveKcVerdict / summarizeRecompute) over the bit-exact core.

import { deriveProfileKc } from '@/core/recompute/derive-profile-kc';
import { describe, expect, it } from 'vitest';
import type { ProfileKc } from '../profile-api';
import { deriveKcVerdict, summarizeRecompute } from './recompute-core';

// A tested KC whose server display EXACTLY equals the device re-derivation (poly regime).
function matchingKc(
  id: string,
  evidence: { s: number; f: number; b: number; prec: number },
): ProfileKc {
  const d = deriveProfileKc({
    success_count: evidence.s,
    fail_count: evidence.f,
    beta: evidence.b,
    theta_precision: evidence.prec,
  });
  return {
    id,
    name: `KC ${id}`,
    tested: true,
    evidence_count: evidence.s + evidence.f,
    success_count: evidence.s,
    fail_count: evidence.f,
    beta: evidence.b,
    theta_precision: evidence.prec,
    theta_se: d.se,
    p_l: d.point,
    mastery_lo: d.lo,
    mastery_hi: d.hi,
    low_confidence: false,
  };
}

const UNTESTED: ProfileKc = {
  id: 'u',
  name: 'untested',
  tested: false,
  evidence_count: 0,
};

describe('deriveKcVerdict — sigma_mode honesty regime (YUK-495 S5 #41)', () => {
  it('untested KC → na (no numbers to re-derive)', () => {
    expect(deriveKcVerdict(UNTESTED, 'poly').kind).toBe('na');
    expect(deriveKcVerdict(UNTESTED, 'libm').kind).toBe('na');
  });

  it('poly + server === device → match, no diffs', () => {
    const kc = matchingKc('a', { s: 5, f: 1, b: 0.8, prec: 9 });
    const v = deriveKcVerdict(kc, 'poly');
    expect(v.kind).toBe('match');
    expect(v.diffs).toHaveLength(0);
  });

  it('poly + a tweaked server field → drift, diff names that field', () => {
    const kc = { ...matchingKc('a', { s: 5, f: 1, b: 0.8, prec: 9 }) };
    // shift p_l by a hair (real bit-difference) → exact Object.is fails on that field only.
    kc.p_l = (kc.p_l as number) + 1e-12;
    const v = deriveKcVerdict(kc, 'poly');
    expect(v.kind).toBe('drift');
    expect(v.diffs.map((d) => d.field)).toEqual(['p_l']);
  });

  it('libm + ≤1-ULP-style server === device at display precision → preview (no false drift)', () => {
    const kc = { ...matchingKc('a', { s: 5, f: 1, b: 0.8, prec: 9 }) };
    // a sub-display-precision wobble (the Math.exp ≤1-ULP regime) must NOT read as drift.
    kc.p_l = (kc.p_l as number) + 1e-9;
    kc.mastery_lo = (kc.mastery_lo as number) - 1e-9;
    const v = deriveKcVerdict(kc, 'libm');
    expect(v.kind).toBe('preview');
    expect(v.diffs).toHaveLength(0);
  });

  it('libm + a display-level (round-2) divergence → drift (a real display bug)', () => {
    const kc = { ...matchingKc('a', { s: 5, f: 1, b: 0.8, prec: 9 }) };
    kc.mastery_hi = (kc.mastery_hi as number) + 0.05; // visible at 2 decimals
    const v = deriveKcVerdict(kc, 'libm');
    expect(v.kind).toBe('drift');
    expect(v.diffs.map((d) => d.field)).toEqual(['mastery_hi']);
  });
});

describe('summarizeRecompute — profile rollup', () => {
  it('all match (poly) → overall match; testedCount excludes na', () => {
    const s = summarizeRecompute(
      [
        matchingKc('a', { s: 3, f: 0, b: 0, prec: 4 }),
        matchingKc('b', { s: 1, f: 2, b: -0.5, prec: 3 }),
        UNTESTED,
      ],
      'poly',
    );
    expect(s.overall).toBe('match');
    expect(s.testedCount).toBe(2);
    expect(s.driftCount).toBe(0);
    expect(s.firstDrift).toBeUndefined();
  });

  it('any drift → overall drift, firstDrift set', () => {
    const bad = { ...matchingKc('b', { s: 1, f: 2, b: -0.5, prec: 3 }) };
    bad.mastery_lo = (bad.mastery_lo as number) + 0.2;
    const s = summarizeRecompute([matchingKc('a', { s: 3, f: 0, b: 0, prec: 4 }), bad], 'poly');
    expect(s.overall).toBe('drift');
    expect(s.driftCount).toBe(1);
    expect(s.firstDrift?.id).toBe('b');
  });

  it('libm clean → overall preview', () => {
    const s = summarizeRecompute([matchingKc('a', { s: 3, f: 0, b: 0, prec: 4 })], 'libm');
    expect(s.overall).toBe('preview');
  });
});
