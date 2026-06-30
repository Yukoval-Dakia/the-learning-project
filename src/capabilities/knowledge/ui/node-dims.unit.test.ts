// A5 S3 (YUK-354) — pure-logic coverage for the NodeComposite three-dim fold.
// No DB, no jsdom. Pins: β→difficulty band thresholds, each axis's cold/data states,
// three-axis orthogonality (each dim banded independently), cold-note threshold, and
// the ⑥ red line (every axis is a discrete band/source, never a bare number).

import { describe, expect, it } from 'vitest';
import type { MasteryBandInput } from './mastery-band';
import {
  BETA_NEUTRAL_EPSILON,
  COLD_NOTE_MAX_EVIDENCE,
  DIFFICULTY_BANDS,
  DIFFICULTY_BETA_THRESHOLDS,
  type NodeThreeDimInput,
  buildNodeThreeDim,
  difficultyBandIdx,
} from './node-dims';

function masteryInput(overrides: Partial<MasteryBandInput> = {}): MasteryBandInput {
  return {
    mastery: 0.7,
    mastery_lo: 0.5,
    mastery_hi: 0.85,
    low_confidence: false,
    evidence_count: 9,
    ...overrides,
  };
}

function input(overrides: Partial<NodeThreeDimInput> = {}): NodeThreeDimInput {
  return {
    mastery: masteryInput(),
    beta: 1,
    retrievability: 0.5,
    evidenceCount: 9,
    ...overrides,
  };
}

describe('difficultyBandIdx (β logit → 4 难度档)', () => {
  it('maps the owner-fixed anchor bucket scale [-2,+2] to monotone difficulty bands', () => {
    expect(difficultyBandIdx(-2)).toBe(0); // very_easy → 容易
    expect(difficultyBandIdx(-1)).toBe(0); // easy → 容易
    expect(difficultyBandIdx(0.2)).toBe(1); // ~medium → 适中
    expect(difficultyBandIdx(1)).toBe(2); // hard → 偏难
    expect(difficultyBandIdx(2)).toBe(3); // very_hard → 很难
  });

  it('uses the named thresholds as inclusive lower bounds of the harder band', () => {
    expect(difficultyBandIdx(DIFFICULTY_BETA_THRESHOLDS.moderate)).toBe(1); // -0.5 → 适中
    expect(difficultyBandIdx(DIFFICULTY_BETA_THRESHOLDS.hard)).toBe(2); // 0.5 → 偏难
    expect(difficultyBandIdx(DIFFICULTY_BETA_THRESHOLDS.veryHard)).toBe(3); // 1.5 → 很难
    expect(difficultyBandIdx(DIFFICULTY_BETA_THRESHOLDS.moderate - 0.01)).toBe(0); // 容易
  });
});

describe('buildNodeThreeDim — orthogonal R / p(L) / difficulty', () => {
  it('returns the three dims in R → p(L) → diff order', () => {
    const three = buildNodeThreeDim(input());
    expect(three.dims.map((d) => d.key)).toEqual(['R', 'pL', 'diff']);
  });

  it('composite scalar = the p(L) view', () => {
    const three = buildNodeThreeDim(input());
    const pL = three.dims.find((d) => d.key === 'pL');
    expect(three.composite).toEqual(pL?.view);
  });

  it('warm node: R / p(L) / difficulty each banded from real evidence (source hard)', () => {
    const three = buildNodeThreeDim(input({ retrievability: 0.5, beta: 1 }));
    const r = three.dims.find((d) => d.key === 'R');
    const pL = three.dims.find((d) => d.key === 'pL');
    const diff = three.dims.find((d) => d.key === 'diff');
    // R = 0.5 → band 1 (成长) on the 0-1 mastery scale, hard (a real fsrs_state row).
    expect(r?.view).toMatchObject({ unknown: false, band: 1, source: 'hard' });
    // p(L) = 0.7 point → band 2 (稳固), with the real σ interval.
    expect(pL?.view).toMatchObject({ unknown: false, band: 2, source: 'hard' });
    // β = 1 → difficulty band 2 (偏难), hard (a real calibration anchor).
    expect(diff?.view).toMatchObject({ unknown: false, band: 2, source: 'hard' });
    expect(diff?.labels).toBe(DIFFICULTY_BANDS);
  });

  it('cold start (no projection / no fsrs / no β): every axis is unknown + soft + low-conf', () => {
    const three = buildNodeThreeDim({
      mastery: null,
      beta: null,
      retrievability: null,
      evidenceCount: 0,
    });
    expect(three.composite).toMatchObject({ unknown: true, source: 'soft', lowConf: true });
    for (const d of three.dims) {
      expect(d.view).toMatchObject({ unknown: true, source: 'soft', lowConf: true });
    }
    expect(three.coldNote).not.toBeNull();
  });

  it('R axis: missing fsrs_state row → unknown (NOT band 0 / fully-forgotten)', () => {
    const three = buildNodeThreeDim(input({ retrievability: null }));
    const r = three.dims.find((d) => d.key === 'R');
    expect(r?.view.unknown).toBe(true);
    expect(r?.view).toMatchObject({ source: 'soft', lowConf: true });
  });

  it('difficulty axis: β neutral (≈0, no anchor) → honestly degraded to unknown + soft + low-conf', () => {
    const three = buildNodeThreeDim(input({ beta: 0 }));
    const diff = three.dims.find((d) => d.key === 'diff');
    expect(diff?.view).toMatchObject({ unknown: true, source: 'soft', lowConf: true });
    // sub-epsilon β is also treated as neutral (no fabricated absolute difficulty band).
    const three2 = buildNodeThreeDim(input({ beta: BETA_NEUTRAL_EPSILON / 2 }));
    expect(three2.dims.find((d) => d.key === 'diff')?.view.unknown).toBe(true);
  });

  it('difficulty axis: point band only — never a fabricated interval (β has no CI)', () => {
    const three = buildNodeThreeDim(input({ beta: 2 }));
    const diff = three.dims.find((d) => d.key === 'diff');
    expect(diff?.view).toMatchObject({ unknown: false, band: 3, loBand: 3, hiBand: 3 });
  });

  it('cold-note shows below the evidence threshold and clears at/above it', () => {
    expect(
      buildNodeThreeDim(input({ evidenceCount: COLD_NOTE_MAX_EVIDENCE - 1 })).coldNote,
    ).not.toBeNull();
    expect(buildNodeThreeDim(input({ evidenceCount: COLD_NOTE_MAX_EVIDENCE })).coldNote).toBeNull();
  });

  it('every dim carries a 4-element label set (qualitative, never bare numbers)', () => {
    const three = buildNodeThreeDim(input());
    for (const d of three.dims) {
      expect(d.labels).toHaveLength(4);
    }
  });
});
