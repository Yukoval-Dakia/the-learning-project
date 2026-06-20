// TASK 2 — forward-AUC via the Mann–Whitney U identity (AUC = P(score_pos > score_neg)).
// Source: Hanley & McNeil, Radiology 1982. Known-answer tests HAND-COMPUTED.

import { describe, expect, it } from 'vitest';
import { forwardAuc } from './auc';

describe('forwardAuc — Mann–Whitney U', () => {
  it('anchor: AUC = 4/6 ≈ 0.6667 (hand-computed pairwise)', () => {
    // scores [0.9,0.6,0.6,0.7,0.5], labels [1,1,1,0,0]
    // P = {0.9,0.6,0.6}, N = {0.7,0.5}; pairs (3*2=6):
    //   (0.9>0.7)=1 (0.9>0.5)=1 (0.6<0.7)=0 (0.6>0.5)=1 (0.6<0.7)=0 (0.6>0.5)=1 → 4
    // AUC = 4/6
    const r = forwardAuc([0.9, 0.6, 0.6, 0.7, 0.5], [1, 1, 1, 0, 0]);
    expect(r.auc).toBeCloseTo(4 / 6, 10);
    expect(r.n).toBe(5);
    expect(r.n1).toBe(3);
    expect(r.n0).toBe(2);
  });

  it('ties count as 0.5: AUC = 3.5/4 = 0.875', () => {
    // P = {0.5,0.8}, N = {0.5,0.2}; pairs (2*2=4):
    //   (0.5==0.5)=0.5 (0.5>0.2)=1 (0.8>0.5)=1 (0.8>0.2)=1 → 3.5
    const r = forwardAuc([0.5, 0.8, 0.5, 0.2], [1, 1, 0, 0]);
    expect(r.auc).toBeCloseTo(0.875, 10);
  });

  it('perfect separation → 1.0', () => {
    const r = forwardAuc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0]);
    expect(r.auc).toBeCloseTo(1.0, 12);
  });

  it('perfectly wrong → 0.0', () => {
    const r = forwardAuc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0]);
    expect(r.auc).toBeCloseTo(0.0, 12);
  });

  it('all positives → null, reason no-negatives', () => {
    const r = forwardAuc([0.9, 0.8, 0.7], [1, 1, 1]);
    expect(r.auc).toBeNull();
    expect(r.reason).toBe('no-negatives');
    expect(r.n1).toBe(3);
    expect(r.n0).toBe(0);
  });

  it('all negatives → null, reason no-positives', () => {
    const r = forwardAuc([0.1, 0.2, 0.3], [0, 0, 0]);
    expect(r.auc).toBeNull();
    expect(r.reason).toBe('no-positives');
  });

  it('empty → null, reason empty, n=0', () => {
    const r = forwardAuc([], []);
    expect(r.auc).toBeNull();
    expect(r.reason).toBe('empty');
    expect(r.n).toBe(0);
  });

  it('length mismatch throws', () => {
    expect(() => forwardAuc([0.1, 0.2], [1])).toThrow(/equal length/);
  });
});
