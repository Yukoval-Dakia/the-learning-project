import type { JudgeResultV2T } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';
import {
  STEP_SIGNAL_VERDICT_OUTCOME,
  extractStepGradingObservations,
  shouldApplyStepGradingTheta,
} from './step-grading-evidence';

function stepsResult(
  overrides: Partial<JudgeResultV2T> & {
    evidence_json?: Record<string, unknown>;
  },
): JudgeResultV2T {
  const base = {
    score_meaning: 'steps_v1_weighted' as const,
    coarse_outcome: 'partial' as const,
    score: 0.5,
    confidence: 0.8,
    capability_ref: { id: 'steps', version: '1.0.0' },
    feedback_md: 'ok',
    evidence_json: {},
  };
  return { ...base, ...overrides } as JudgeResultV2T;
}

describe('extractStepGradingObservations', () => {
  it('maps signal_verdicts to FIXED partial-binarize credits', () => {
    const result = stepsResult({
      evidence_json: {
        signal_verdicts: [
          { signal_idx: 0, verdict: 'correct', comment: 'a' },
          { signal_idx: 1, verdict: 'partial', comment: 'b' },
          { signal_idx: 2, verdict: 'wrong', comment: 'c' },
          { signal_idx: 3, verdict: 'skipped', comment: 'd' },
        ],
      },
    });
    const obs = extractStepGradingObservations(result);
    expect(obs).toEqual([
      { signal_idx: 0, verdict: 'correct', continuousCredit: 1 },
      { signal_idx: 1, verdict: 'partial', continuousCredit: 0.5 },
      { signal_idx: 2, verdict: 'wrong', continuousCredit: 0 },
      { signal_idx: 3, verdict: 'skipped', continuousCredit: 0 },
    ]);
    expect(STEP_SIGNAL_VERDICT_OUTCOME.partial).toBe(0.5);
  });

  it('returns null for non-steps score_meaning', () => {
    const result = stepsResult({
      score_meaning: 'correctness',
      evidence_json: {
        signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: '' }],
      },
    } as unknown as Partial<JudgeResultV2T>);
    expect(extractStepGradingObservations(result as JudgeResultV2T)).toBeNull();
  });

  it('returns null for unsupported coarse_outcome', () => {
    const result = stepsResult({
      coarse_outcome: 'unsupported',
      score: null,
      evidence_json: {
        signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: '' }],
      },
    } as unknown as Partial<JudgeResultV2T>);
    expect(extractStepGradingObservations(result as JudgeResultV2T)).toBeNull();
  });

  it('returns null when signal_verdicts missing (accelerator path)', () => {
    const result = stepsResult({
      evidence_json: { accelerator: 'final_answer_match', step_score_raw: null },
    });
    expect(extractStepGradingObservations(result)).toBeNull();
  });

  it('returns null on malformed verdict entries', () => {
    const result = stepsResult({
      evidence_json: {
        signal_verdicts: [{ signal_idx: 0, verdict: 'maybe', comment: '' }],
      },
    });
    expect(extractStepGradingObservations(result)).toBeNull();
  });
});

describe('shouldApplyStepGradingTheta', () => {
  const obs = [{ signal_idx: 0, verdict: 'correct' as const, continuousCredit: 1 as const }];

  it('requires flag ON + calibrated + non-empty observations', () => {
    expect(shouldApplyStepGradingTheta(false, true, obs)).toBe(false);
    expect(shouldApplyStepGradingTheta(true, false, obs)).toBe(false);
    expect(shouldApplyStepGradingTheta(true, true, null)).toBe(false);
    expect(shouldApplyStepGradingTheta(true, true, [])).toBe(false);
    expect(shouldApplyStepGradingTheta(true, true, obs)).toBe(true);
  });
});
