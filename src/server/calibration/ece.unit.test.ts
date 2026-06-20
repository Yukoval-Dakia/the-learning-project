// TASK 1 — ECE (Expected Calibration Error) + reliability table.
// Source: binned reliability (Naeini et al., AAAI 2015; Guo et al., ICML 2017).
// Known-answer tests use HAND-COMPUTED expected values (math correctness is the #1 risk).

import { describe, expect, it } from 'vitest';
import { ece } from './ece';

describe('ece — binned reliability', () => {
  it('anchor: ECE = 0.06 (N=10, K=2, equal-width, hand-computed)', () => {
    // preds:  low bin [0,0.5) = {0.2,0.3,0.4,0.1,0.3}, labels {0,0,1,0,0}
    //   conf = 1.3/5 = 0.26, acc = 1/5 = 0.20, gap = 0.06, n = 5
    // preds:  high bin [0.5,1.0] = {0.6,0.7,0.8,0.9,0.7}, labels {1,0,1,1,1}
    //   conf = 3.7/5 = 0.74, acc = 4/5 = 0.80, gap = 0.06, n = 5
    // ECE = (5/10)*0.06 + (5/10)*0.06 = 0.06
    const preds = [0.2, 0.3, 0.4, 0.1, 0.3, 0.6, 0.7, 0.8, 0.9, 0.7];
    const labels: (0 | 1)[] = [0, 0, 1, 0, 0, 1, 0, 1, 1, 1];
    const r = ece(preds, labels, { binning: 'equal-width', k: 2 });
    expect(r.ece).toBeCloseTo(0.06, 10);
    expect(r.n).toBe(10);
    expect(r.bins).toHaveLength(2);

    const low = r.bins[0];
    expect(low.n).toBe(5);
    expect(low.conf).toBeCloseTo(0.26, 10);
    expect(low.acc).toBeCloseTo(0.2, 10);
    expect(low.gap).toBeCloseTo(0.06, 10);

    const high = r.bins[1];
    expect(high.n).toBe(5);
    expect(high.conf).toBeCloseTo(0.74, 10);
    expect(high.acc).toBeCloseTo(0.8, 10);
    expect(high.gap).toBeCloseTo(0.06, 10);
  });

  it('perfect calibration → ECE = 0', () => {
    const r = ece([0, 0, 1, 1], [0, 0, 1, 1], { binning: 'equal-width', k: 2 });
    expect(r.ece).toBeCloseTo(0, 12);
  });

  it('p=1.0 boundary lands in the last closed bin (equal-width, K=10)', () => {
    // both preds = 1.0 → bin 9 [0.9,1.0]; labels {1,0} → conf=1.0, acc=0.5, gap=0.5
    const r = ece([1, 1], [1, 0], { binning: 'equal-width', k: 10 });
    const last = r.bins.find((b) => b.n > 0);
    expect(last).toBeDefined();
    expect(last?.n).toBe(2);
    expect(last?.conf).toBeCloseTo(1.0, 12);
    expect(last?.acc).toBeCloseTo(0.5, 12);
    expect(r.ece).toBeCloseTo(0.5, 12);
  });

  it('empty bins are skipped (zero weight) — all preds in [0,0.1), K=10', () => {
    // all 4 preds in bin 0; labels {1,0,1,0} → conf = mean(0.01..0.09), acc=0.5
    const preds = [0.01, 0.03, 0.07, 0.09];
    const labels: (0 | 1)[] = [1, 0, 1, 0];
    const r = ece(preds, labels, { binning: 'equal-width', k: 10 });
    const nonEmpty = r.bins.filter((b) => b.n > 0);
    expect(nonEmpty).toHaveLength(1);
    // ECE equals the single non-empty bin's gap (it carries all the weight).
    expect(r.ece).toBeCloseTo(nonEmpty[0].gap, 12);
  });

  it('equal-count splits N=10 into K=5 bins of 2 each', () => {
    const preds = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95];
    const labels: (0 | 1)[] = [0, 0, 0, 0, 1, 0, 1, 1, 1, 1];
    const r = ece(preds, labels, { binning: 'equal-count', k: 5 });
    expect(r.bins).toHaveLength(5);
    expect(r.bins.every((b) => b.n === 2)).toBe(true);
  });

  it('N=0 → {ece:0, n:0, bins:[]} (does NOT throw — caller decides)', () => {
    const r = ece([], []);
    expect(r.ece).toBe(0);
    expect(r.n).toBe(0);
    expect(r.bins).toHaveLength(0);
  });

  it('length mismatch throws', () => {
    expect(() => ece([0.1, 0.2], [0])).toThrow(/equal length/);
  });
});
