import type { JudgeResultV2T } from '@/core/schema/capability';
import { describe, expect, it } from 'vitest';
import {
  buildVerdictRows,
  extractStepsEvidence,
  judgeRouteLabel,
  verdictLabel,
} from './judge-result-format';

describe('judgeRouteLabel', () => {
  it('maps known route ids to Chinese labels', () => {
    expect(judgeRouteLabel('steps')).toBe('steps@1 视觉判分');
    expect(judgeRouteLabel('exact')).toBe('exact 严格比对');
    expect(judgeRouteLabel('keyword')).toBe('keyword 关键词');
    expect(judgeRouteLabel('semantic')).toBe('semantic 语义判分');
  });

  it('falls back to raw id for unknown route', () => {
    expect(judgeRouteLabel('rubric')).toBe('rubric');
    expect(judgeRouteLabel('experimental:foo')).toBe('experimental:foo');
  });
});

describe('verdictLabel', () => {
  it('maps each verdict enum to Chinese label', () => {
    expect(verdictLabel('correct')).toBe('正确');
    expect(verdictLabel('partial')).toBe('部分');
    expect(verdictLabel('wrong')).toBe('错误');
    expect(verdictLabel('skipped')).toBe('未答');
  });
});

describe('buildVerdictRows', () => {
  it('zips expected_signals with signal_verdicts by signal_idx', () => {
    const rows = buildVerdictRows(
      ['用平方差', '约去 a-b', '得 a+b'],
      [
        { signal_idx: 0, verdict: 'correct', comment: 'ok' },
        { signal_idx: 1, verdict: 'partial', comment: 'almost' },
        { signal_idx: 2, verdict: 'wrong', comment: 'forgot' },
      ],
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      signal_idx: 0,
      signal_text: '用平方差',
      verdict: 'correct',
    });
    expect(rows[2].verdict).toBe('wrong');
  });

  it('marks signals without a verdict entry as skipped', () => {
    const rows = buildVerdictRows(
      ['signal a', 'signal b'],
      [{ signal_idx: 0, verdict: 'correct', comment: '' }],
    );
    expect(rows[1]).toMatchObject({ verdict: 'skipped', comment: '' });
  });
});

describe('extractStepsEvidence', () => {
  it('narrows JudgeResultV2.evidence_json to steps shape', () => {
    const result: JudgeResultV2T = {
      score: 0.4,
      score_meaning: 'steps_v1_weighted',
      coarse_outcome: 'partial',
      confidence: 0.9,
      capability_ref: { id: 'steps', version: '1.0.0' },
      feedback_md: 'ok',
      evidence_json: {
        signal_verdicts: [{ signal_idx: 0, verdict: 'partial', comment: 'x' }],
        extracted_final_answer: 'x²+3x',
        step_score_raw: 0.5,
        step_weight: 0.6,
      },
    };
    const e = extractStepsEvidence(result);
    expect(e.signal_verdicts).toHaveLength(1);
    expect(e.extracted_final_answer).toBe('x²+3x');
    expect(e.step_score_raw).toBe(0.5);
  });

  it('returns undefined fields when evidence_json shape is alien', () => {
    const result: JudgeResultV2T = {
      score: null,
      score_meaning: 'correctness',
      coarse_outcome: 'unsupported',
      confidence: 0,
      capability_ref: { id: 'exact', version: '1.0.0' },
      feedback_md: 'fail',
      evidence_json: { whatever: 'unrelated' },
    };
    const e = extractStepsEvidence(result);
    expect(e.signal_verdicts).toBeUndefined();
    expect(e.extracted_final_answer).toBeUndefined();
    expect(e.accelerator).toBeUndefined();
  });
});
