// YUK-495 S5 #41 — UI verdict layer (deriveKcVerdict / summarizeRecompute) over the bit-exact core.

import { deriveProfileKc } from '@/core/recompute/derive-profile-kc';
import { describe, expect, it } from 'vitest';
import type { ProfileKc } from '../profile-api';
import type {
  CalibrationMaturityResponse,
  CalibrationMaturityRow,
} from './calibration-maturity-api';
import { deriveKcVerdict, summarizeMaturity, summarizeRecompute } from './recompute-core';

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

// ── D2: summarizeMaturity — calibration-maturity reconciliation (YUK-495 S5 #41 #45) ──

function maturityRow(
  knowledge_id: string,
  opts: { theta_se: number | null; cold_start: boolean },
): CalibrationMaturityRow {
  return {
    knowledge_id,
    name: `KC ${knowledge_id}`,
    evidence_count: 0,
    theta_se: opts.theta_se,
    confidence: null,
    track: null,
    cold_start: opts.cold_start,
  };
}

// Mirror the server median EXACTLY (server/calibration-maturity.ts): filter non-null,
// sort ascending, floor-mid midpoint. Used to construct a consistent aggregate so a
// well-formed response matches by construction.
function serverMedian(rows: CalibrationMaturityRow[]): number | null {
  const sorted = rows
    .map((r) => r.theta_se)
    .filter((x): x is number => x != null)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// Build a server response whose aggregate is computed by the same rules as the server,
// so device re-derivation reconciles bit-for-bit unless we deliberately perturb it.
function buildResponse(rows: CalibrationMaturityRow[]): CalibrationMaturityResponse {
  const firm_count = rows.filter((r) => !r.cold_start).length;
  const total = rows.length;
  return {
    rows,
    aggregate: {
      total_kcs: total,
      cold_start_count: total - firm_count,
      firm_count,
      pct_firm: total === 0 ? 0 : Math.round((firm_count / total) * 10_000) / 10_000,
      median_theta_se: serverMedian(rows),
    },
  };
}

describe('summarizeMaturity — calibration-maturity reconciliation', () => {
  it('device re-derivation === server aggregate → match', () => {
    const resp = buildResponse([
      maturityRow('a', { theta_se: 0.5, cold_start: false }),
      maturityRow('b', { theta_se: 0.3, cold_start: false }),
      maturityRow('c', { theta_se: 0.7, cold_start: true }),
    ]);
    const s = summarizeMaturity(resp);
    expect(s.overall).toBe('match');
    expect(s.dFirm).toBe(resp.aggregate.firm_count);
    expect(Object.is(s.dMedian, resp.aggregate.median_theta_se)).toBe(true);
    expect(s.total).toBe(3);
  });

  it('server firm_count disagreeing with device re-derivation → drift', () => {
    const resp = buildResponse([
      maturityRow('a', { theta_se: 0.5, cold_start: false }),
      maturityRow('b', { theta_se: 0.3, cold_start: false }),
      maturityRow('c', { theta_se: 0.7, cold_start: true }),
    ]);
    const drifted: CalibrationMaturityResponse = {
      ...resp,
      aggregate: { ...resp.aggregate, firm_count: resp.aggregate.firm_count + 1 },
    };
    const s = summarizeMaturity(drifted);
    expect(s.overall).toBe('drift');
    expect(s.dFirm).toBe(2); // a, b are !cold_start
    expect(s.sFirm).toBe(3); // perturbed server value
  });

  it('median is a bit-exact mirror of the server (even + odd)', () => {
    // Even count: sorted [0.1, 0.3, 0.5, 0.7], mid=2 → (0.3 + 0.5) / 2 = 0.4.
    const even = buildResponse([
      maturityRow('a', { theta_se: 0.5, cold_start: false }),
      maturityRow('b', { theta_se: 0.3, cold_start: false }),
      maturityRow('c', { theta_se: 0.7, cold_start: true }),
      maturityRow('d', { theta_se: 0.1, cold_start: false }),
    ]);
    const se = summarizeMaturity(even);
    expect(Object.is(se.dMedian, 0.4)).toBe(true);
    expect(Object.is(se.dMedian, even.aggregate.median_theta_se)).toBe(true);
    expect(se.overall).toBe('match');

    // Odd count: sorted [0.3, 0.5, 0.7], mid=1 → 0.5.
    const odd = buildResponse([
      maturityRow('a', { theta_se: 0.5, cold_start: false }),
      maturityRow('b', { theta_se: 0.3, cold_start: false }),
      maturityRow('c', { theta_se: 0.7, cold_start: false }),
    ]);
    const so = summarizeMaturity(odd);
    expect(Object.is(so.dMedian, 0.5)).toBe(true);
    expect(Object.is(so.dMedian, odd.aggregate.median_theta_se)).toBe(true);
  });

  it('rows all theta_se=null → median null on both sides → match', () => {
    const resp = buildResponse([
      maturityRow('a', { theta_se: null, cold_start: true }),
      maturityRow('b', { theta_se: null, cold_start: true }),
    ]);
    const s = summarizeMaturity(resp);
    expect(s.dMedian).toBeNull();
    expect(s.sMedian).toBeNull();
    expect(Object.is(s.dMedian, s.sMedian)).toBe(true);
    expect(s.overall).toBe('match');
  });
});
