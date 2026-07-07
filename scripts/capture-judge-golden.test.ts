// YUK-573 (MF1 capture chain) — pure-mapper unit for the owner-run capture
// tool. The CLI itself is owner-run against prod (db imported LAZILY inside
// main() so this module stays unit-partition-safe); the mapping from a
// calibration observation row → fixture skeleton is pure and pinned here.
import { describe, expect, it } from 'vitest';

import { candidateToFixtureSkeleton } from './capture-judge-golden';

describe('candidateToFixtureSkeleton', () => {
  it('maps a calibration candidate into a judge-golden case skeleton with desensitize markers', () => {
    const skeleton = candidateToFixtureSkeleton({
      samplePayload: {
        original_outcome: 'correct',
        rejudge_outcome: 'incorrect',
        rejudge_route: 'semantic',
        rejudge_confidence: 0.8,
        rejudge_raw_output: '{"score":0.1,"coarse_outcome":"incorrect"}',
        original_judge_event_id: 'j-1',
        question_id: 'q-1',
        answer_event_id: 'a-1',
      },
      question: {
        id: 'q-1',
        kind: 'short_answer',
        prompt_md: '真实题面（需脱敏）',
        reference_md: '真实参考',
        rubric_json: { required_points: ['甲'] },
        choices_md: null,
        judge_kind_override: null,
      },
      answerPayload: { answer_md: '真实作答', answer_image_refs: [] },
    });
    if (skeleton === null) throw new Error('expected a skeleton for a raw-output-bearing row');

    // Route is FORCED via judge_kind_override so the replayed case can't drift
    // to a different route than the one that produced the frozen output.
    expect(skeleton.question).toMatchObject({
      kind: 'short_answer',
      prompt_md: '真实题面（需脱敏）',
      judge_kind_override: 'semantic',
    });
    expect(skeleton.answer_md).toBe('真实作答');
    expect(skeleton.student_image_refs).toEqual([]);
    expect(skeleton.frozen_llm_output).toBe('{"score":0.1,"coarse_outcome":"incorrect"}');
    // expected pins the RE-JUDGE verdict (the lane that produced the frozen
    // text), NOT the original — replay must reproduce what the raw text parses to.
    expect(skeleton.expected).toMatchObject({ route: 'semantic', coarse_outcome: 'incorrect' });
    // The skeleton must scream desensitization before commit.
    expect(JSON.stringify(skeleton)).toContain('DESENSITIZE');
  });

  it('drops rows without raw output (nothing to freeze)', () => {
    expect(
      candidateToFixtureSkeleton({
        samplePayload: {
          original_outcome: 'correct',
          rejudge_outcome: 'correct',
          rejudge_route: 'semantic',
          rejudge_confidence: 0.8,
          rejudge_raw_output: null,
          original_judge_event_id: 'j-2',
          question_id: 'q-2',
          answer_event_id: 'a-2',
        },
        question: {
          id: 'q-2',
          kind: 'short_answer',
          prompt_md: 'p',
          reference_md: null,
          rubric_json: null,
          choices_md: null,
          judge_kind_override: null,
        },
        answerPayload: { answer_md: 'x' },
      }),
    ).toBeNull();
  });
});
