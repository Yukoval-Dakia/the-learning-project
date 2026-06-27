import { describe, expect, it } from 'vitest';
import {
  EZ_SCALING_S,
  type EzInputs,
  computeEzDiffusion,
  edgeCorrectPc,
  ezFromResponses,
} from './ez-diffusion';

// ── Reference forward EZ equations (Wagenmakers 2007 Eqs. 1-3) ──────────────────────────────
// Data-generating side, used ONLY in tests to manufacture (Pc, MRT, VRT) from a known
// (v, a, Ter) so we can assert the SHIPPED recovery inverts the model exactly. Kept here (not
// in the prod module) because production only ever recovers parameters from data.
function forwardEz(v: number, a: number, ter: number, s = EZ_SCALING_S) {
  const z = (a * v) / (s * s);
  const e = Math.exp(-z);
  const pc = 1 / (1 + e);
  const mdt = (a / (2 * v)) * ((1 - e) / (1 + e));
  const mrt = ter + mdt;
  const vrt = ((a * s * s) / (2 * v ** 3)) * ((1 - 2 * z * e - e * e) / (1 + e) ** 2);
  return { pc, mrt, vrt };
}

describe('computeEzDiffusion — closed-form recovery (Wagenmakers 2007)', () => {
  it('round-trips known (v,a,Ter) through the forward model to machine precision', () => {
    const cases: Array<[number, number, number]> = [
      [0.25, 0.1, 0.3],
      [0.15, 0.12, 0.25],
      [0.35, 0.08, 0.2],
      [0.2, 0.14, 0.35],
    ];
    for (const [v, a, ter] of cases) {
      const { pc, mrt, vrt } = forwardEz(v, a, ter);
      const r = computeEzDiffusion({ pc, vrt, mrt, n: 100 });
      expect(r.reason).toBe('ok');
      expect(r.v).toBeCloseTo(v, 9);
      expect(r.a).toBeCloseTo(a, 9);
      expect(r.ter).toBeCloseTo(ter, 9);
    }
  });

  it('matches an independently-computed pinned reference (catches transcription drift)', () => {
    // recover(Pc=0.8027, VRT=0.1112, MRT=0.7231, s=0.1) computed independently in Python.
    const r = computeEzDiffusion({ pc: 0.8027, vrt: 0.1112, mrt: 0.7231, n: 200 });
    expect(r.reason).toBe('ok');
    expect(r.v).toBeCloseTo(0.1003821564, 9);
    expect(r.a).toBeCloseTo(0.1397913417, 9);
    expect(r.ter).toBeCloseTo(0.301562541, 9);
  });

  it('recovers a NEGATIVE drift for below-chance accuracy (Pc < 0.5)', () => {
    const r = computeEzDiffusion({ pc: 0.35, vrt: 0.05, mrt: 0.6, n: 50 });
    expect(r.reason).toBe('ok');
    expect(r.v).not.toBeNull();
    expect(r.v as number).toBeLessThan(0);
    // a = s²·L/v with L<0 and v<0 → a stays positive (boundary separation is a magnitude).
    expect(r.a as number).toBeGreaterThan(0);
  });

  it('s scales drift (descriptor depends on the owner-fixed convention)', () => {
    const base: EzInputs = { pc: 0.8, vrt: 0.05, mrt: 0.5, n: 100 };
    const a01 = computeEzDiffusion({ ...base, s: 0.1 });
    const a1 = computeEzDiffusion({ ...base, s: 1 });
    expect(a01.reason).toBe('ok');
    expect(a1.reason).toBe('ok');
    // v ∝ s, so a 10× s gives a 10× v.
    expect((a1.v as number) / (a01.v as number)).toBeCloseTo(10, 6);
  });
});

describe('edgeCorrectPc — Wagenmakers Appendix', () => {
  it('nudges perfect / zero accuracy in by half an observation', () => {
    expect(edgeCorrectPc(1, 40)).toBeCloseTo(1 - 1 / 80, 12);
    expect(edgeCorrectPc(0, 40)).toBeCloseTo(1 / 80, 12);
  });
  it('leaves interior Pc untouched', () => {
    expect(edgeCorrectPc(0.73, 40)).toBe(0.73);
  });
  it('makes Pc=1 recoverable instead of producing Infinity', () => {
    const r = computeEzDiffusion({ pc: 1, vrt: 0.02, mrt: 0.4, n: 40 });
    expect(r.reason).toBe('ok');
    expect(r.pcUsed).toBeCloseTo(0.9875, 6);
    expect(Number.isFinite(r.v as number)).toBe(true);
  });
});

describe('computeEzDiffusion — degenerate / contradictory inputs return null (no fabrication)', () => {
  it('Pc == 0.5 (chance) → degenerate-chance, all null', () => {
    const r = computeEzDiffusion({ pc: 0.5, vrt: 0.05, mrt: 0.5, n: 100 });
    expect(r).toMatchObject({ v: null, a: null, ter: null, reason: 'degenerate-chance' });
  });

  it('VRT <= 0 → nonpositive-vrt, all null', () => {
    const r = computeEzDiffusion({ pc: 0.8, vrt: 0, mrt: 0.5, n: 100 });
    expect(r.reason).toBe('nonpositive-vrt');
    expect(r.v).toBeNull();
  });

  it('non-finite / out-of-range inputs → invalid-input', () => {
    expect(computeEzDiffusion({ pc: Number.NaN, vrt: 0.05, mrt: 0.5, n: 10 }).reason).toBe(
      'invalid-input',
    );
    expect(computeEzDiffusion({ pc: 1.2, vrt: 0.05, mrt: 0.5, n: 10 }).reason).toBe(
      'invalid-input',
    );
    expect(computeEzDiffusion({ pc: 0.8, vrt: 0.05, mrt: 0.5, n: 0 }).reason).toBe('invalid-input');
    expect(computeEzDiffusion({ pc: 0.8, vrt: 0.05, mrt: 0.5, n: 10, s: 0 }).reason).toBe(
      'invalid-input',
    );
  });
});

describe('ezFromResponses — pure per-KC reducer', () => {
  it('computes Pc + correct-RT moments then recovers (matches a hand-built equivalent)', () => {
    const correctRt = [0.5, 0.6, 0.55, 0.7, 0.65]; // 5 correct RTs (seconds)
    const correctCount = 5;
    const totalCount = 8; // → Pc = 0.625
    const r = ezFromResponses(correctRt, correctCount, totalCount);
    // Hand-derive the same sufficient statistics and feed computeEzDiffusion directly.
    const m = correctRt.length;
    const mean = correctRt.reduce((a, x) => a + x, 0) / m;
    const ss = correctRt.reduce((a, x) => a + (x - mean) ** 2, 0);
    const vrt = ss / (m - 1);
    const direct = computeEzDiffusion({ pc: 0.625, vrt, mrt: mean, n: 8 });
    expect(r.reason).toBe('ok');
    expect(r.v).toBeCloseTo(direct.v as number, 12);
    expect(r.a).toBeCloseTo(direct.a as number, 12);
    expect(r.ter).toBeCloseTo(direct.ter as number, 12);
  });

  it('fewer than 2 correct RTs → nonpositive-vrt (no variance, no recovery)', () => {
    expect(ezFromResponses([0.5], 1, 4).reason).toBe('nonpositive-vrt');
    expect(ezFromResponses([], 0, 4).reason).toBe('nonpositive-vrt');
  });

  it('rejects incoherent counts', () => {
    expect(ezFromResponses([0.5, 0.6], 5, 3).reason).toBe('invalid-input'); // correct > total
    expect(ezFromResponses([0.5, 0.6], 2, 0).reason).toBe('invalid-input'); // total < 1
  });
});
