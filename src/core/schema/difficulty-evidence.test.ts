import { describe, expect, it } from 'vitest';
import {
  DifficultyEvidence,
  ProducerDifficultyEvidence,
  buildProducerDifficultyEvidence,
  buildSourceLabelDifficultyEvidence,
  resolveDifficultyEvidence,
} from './difficulty-evidence';

describe('DifficultyEvidence', () => {
  it('represents jyeoo dg as an honest source label rather than calibrated b', () => {
    expect(
      buildSourceLabelDifficultyEvidence({
        value: 4,
        scale: 'jyeoo_dg_v1',
        confidence: 0.72,
        sourceRoute: 'jyeoo_adapter',
      }),
    ).toEqual({
      version: 1,
      value: 4,
      scale: 'jyeoo_dg_v1',
      basis: 'source_label',
      confidence: 0.72,
      source_route: 'jyeoo_adapter',
    });
  });

  it('builds a bounded producer estimate while preserving numeric difficulty', () => {
    const evidence = buildProducerDifficultyEvidence(3, 'quiz_gen');
    expect(evidence).toMatchObject({
      value: 3,
      scale: 'loom_difficulty_1_5',
      basis: 'producer_estimate',
      source_route: 'quiz_gen',
    });
    expect(evidence.confidence).toBeGreaterThan(0);
    expect(evidence.confidence).toBeLessThan(1);
  });

  it('calibrated item evidence outranks a stored source label without mutating it', () => {
    const stored = buildSourceLabelDifficultyEvidence({
      value: 5,
      scale: 'jyeoo_dg_v1',
      confidence: 0.8,
    });
    expect(resolveDifficultyEvidence({ calibratedB: -0.4, stored, legacyDifficulty: 5 })).toEqual({
      version: 1,
      value: -0.4,
      scale: 'rasch_logit_b',
      basis: 'item_calibration',
      confidence: 1,
    });
    expect(stored.basis).toBe('source_label');
  });

  it('keeps legacy numeric rows readable as a weak fallback', () => {
    expect(resolveDifficultyEvidence({ calibratedB: null, legacyDifficulty: 2 })).toEqual({
      version: 1,
      value: 2,
      scale: 'loom_difficulty_1_5',
      basis: 'legacy_numeric',
      confidence: 0.2,
    });
  });

  it('rejects out-of-range confidence and invalid loom values', () => {
    expect(() =>
      DifficultyEvidence.parse({
        version: 1,
        value: 3,
        scale: 'jyeoo_dg_v1',
        basis: 'source_label',
        confidence: 1.1,
      }),
    ).toThrow();
    expect(() => buildProducerDifficultyEvidence(9, 'quiz_gen')).toThrow();
    expect(() =>
      ProducerDifficultyEvidence.parse({
        version: 1,
        value: 0,
        scale: 'rasch_logit_b',
        basis: 'item_calibration',
        confidence: 1,
      }),
    ).toThrow();
  });

  it('treats a wild calibrated logit as a calibration bug, not a hard item', () => {
    // Schema contract: canonical rasch_logit_b is bounded.
    expect(() =>
      DifficultyEvidence.parse({
        version: 1,
        value: 1e15,
        scale: 'rasch_logit_b',
        basis: 'item_calibration',
        confidence: 1,
      }),
    ).toThrow();
    // Read path: a wild b falls through to the next evidence tier instead of throwing.
    const resolved = resolveDifficultyEvidence({
      calibratedB: 1e15,
      stored: undefined,
      legacyDifficulty: 3,
    });
    expect(resolved.basis).toBe('legacy_numeric');
    expect(resolved.value).toBe(3);
  });
});
