// A5 S1 (YUK-354) — pure (no-DB) coverage for the mastery band derivation.
// Pins the 4-band thresholds (drift guard), interval band-化, source 二态, the
// cold-start unknown first-class state, and lowConf pass-through.

import { describe, expect, it } from 'vitest';
import {
  A5_BANDS,
  MASTERY_BAND_THRESHOLDS,
  type MasteryBandInput,
  masteryBandIdx,
  masteryBandUnknown,
  masteryBandView,
} from './mastery-band';

function input(overrides: Partial<MasteryBandInput> = {}): MasteryBandInput {
  return {
    mastery: 0.7,
    mastery_lo: 0.6,
    mastery_hi: 0.85,
    low_confidence: false,
    evidence_count: 5,
    ...overrides,
  };
}

describe('MASTERY_BAND_THRESHOLDS / A5_BANDS (drift guard)', () => {
  it('pins the 4-band thresholds at 0.4 / 0.6 / 0.8', () => {
    expect(MASTERY_BAND_THRESHOLDS).toEqual({ growing: 0.4, solid: 0.6, mastered: 0.8 });
  });

  it('pins the 4 band labels in order', () => {
    expect(A5_BANDS).toEqual(['萌芽', '成长', '稳固', '精熟']);
  });
});

describe('masteryBandIdx', () => {
  it('maps the 4-band boundaries (lower-inclusive)', () => {
    // 萌芽 < 0.4
    expect(masteryBandIdx(0)).toBe(0);
    expect(masteryBandIdx(0.39)).toBe(0);
    // 成长 [0.4, 0.6)
    expect(masteryBandIdx(0.4)).toBe(1);
    expect(masteryBandIdx(0.59)).toBe(1);
    // 稳固 [0.6, 0.8)
    expect(masteryBandIdx(0.6)).toBe(2);
    expect(masteryBandIdx(0.79)).toBe(2);
    // 精熟 ≥ 0.8
    expect(masteryBandIdx(0.8)).toBe(3);
    expect(masteryBandIdx(1)).toBe(3);
  });
});

describe('masteryBandView', () => {
  it('bands the point and bands lo/hi each through their own real interval', () => {
    // lo=0.5 → 成长(1), point=0.7 → 稳固(2), hi=0.85 → 精熟(3)
    const v = masteryBandView(input({ mastery: 0.7, mastery_lo: 0.5, mastery_hi: 0.85 }));
    expect(v.unknown).toBe(false);
    if (v.unknown) throw new Error('expected known band');
    expect(v.band).toBe(2);
    expect(v.loBand).toBe(1);
    expect(v.hiBand).toBe(3);
  });

  it('uses real mastery_lo/hi (not a mock evidence-estimated spread)', () => {
    // A tight real interval keeps lo/hi on the same band as the point even with
    // sparse evidence — proving we read the true interval, not an evidence guess.
    const v = masteryBandView(
      input({ mastery: 0.7, mastery_lo: 0.68, mastery_hi: 0.72, evidence_count: 1 }),
    );
    if (v.unknown) throw new Error('expected known band');
    expect(v.band).toBe(2);
    expect(v.loBand).toBe(2);
    expect(v.hiBand).toBe(2);
  });

  it('source = hard when evidence_count > 0', () => {
    const v = masteryBandView(input({ evidence_count: 3 }));
    expect(v.source).toBe('hard');
  });

  it('source = soft when evidence_count === 0 (prior, not calibration)', () => {
    const v = masteryBandView(input({ evidence_count: 0 }));
    expect(v.source).toBe('soft');
  });

  it('passes low_confidence through', () => {
    expect(masteryBandView(input({ low_confidence: true })).lowConf).toBe(true);
    expect(masteryBandView(input({ low_confidence: false })).lowConf).toBe(false);
  });

  it('falls back to the point band when the wire omits the interval', () => {
    const v = masteryBandView(input({ mastery: 0.7, mastery_lo: null, mastery_hi: null }));
    if (v.unknown) throw new Error('expected known band');
    expect(v.loBand).toBe(2);
    expect(v.hiBand).toBe(2);
  });

  it('cold start (mastery null) → first-class unknown state + soft + lowConf', () => {
    const v = masteryBandView(
      input({ mastery: null, mastery_lo: null, mastery_hi: null, evidence_count: 0 }),
    );
    expect(v.unknown).toBe(true);
    expect(v.source).toBe('soft');
    expect(v.lowConf).toBe(true);
    // not treated as band 0 — no band/loBand/hiBand fields on the unknown branch.
    expect('band' in v).toBe(false);
  });
});

describe('masteryBandUnknown', () => {
  it('is the explicit cold-start view (unknown + soft + lowConf)', () => {
    expect(masteryBandUnknown()).toEqual({ unknown: true, source: 'soft', lowConf: true });
  });
});
