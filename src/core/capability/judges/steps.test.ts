import { describe, expect, it } from 'vitest';
import {
  StepsJudgeInput,
  StepsLlmOutput,
  StepsReferenceSolution,
  stepsV1Capability,
} from './steps';

describe('StepsReferenceSolution', () => {
  it('parses valid reference solution with all fields', () => {
    const parsed = StepsReferenceSolution.parse({
      expected_signals: ['识别为不定积分', '按幂法则分项积分'],
      final_answer: 'x² + 3x + C',
      answer_equivalents: ['x^2 + 3x + C'],
    });
    expect(parsed.expected_signals).toHaveLength(2);
    expect(parsed.answer_equivalents).toEqual(['x^2 + 3x + C']);
  });

  it('defaults answer_equivalents to []', () => {
    const parsed = StepsReferenceSolution.parse({
      expected_signals: ['signal a'],
      final_answer: '42',
    });
    expect(parsed.answer_equivalents).toEqual([]);
  });

  it('rejects empty expected_signals', () => {
    expect(() =>
      StepsReferenceSolution.parse({
        expected_signals: [],
        final_answer: '42',
      }),
    ).toThrow();
  });
});

describe('StepsJudgeInput', () => {
  it('accepts input with only image_refs (no text steps, no final_answer)', () => {
    const parsed = StepsJudgeInput.parse({
      prompt_md: '求 ∫(2x+3)dx',
      reference_solution: {
        expected_signals: ['幂法则'],
        final_answer: 'x² + 3x + C',
      },
      student_image_refs: ['asset_1'],
      step_weight: 0.4,
    });
    expect(parsed.student_image_refs).toEqual(['asset_1']);
    expect(parsed.student_text_steps).toBeUndefined();
    expect(parsed.student_final_answer_text).toBeUndefined();
  });

  it('accepts input with text steps and final_answer (no images)', () => {
    const parsed = StepsJudgeInput.parse({
      prompt_md: '求 ∫(2x+3)dx',
      reference_solution: {
        expected_signals: ['幂法则'],
        final_answer: 'x² + 3x + C',
      },
      student_image_refs: [],
      student_text_steps: ['∫2x dx = x²', '∫3 dx = 3x'],
      student_final_answer_text: 'x² + 3x + C',
      step_weight: 0.4,
    });
    expect(parsed.student_text_steps).toHaveLength(2);
    expect(parsed.student_final_answer_text).toBe('x² + 3x + C');
  });

  it('rejects step_weight out of range', () => {
    expect(() =>
      StepsJudgeInput.parse({
        prompt_md: 'x',
        reference_solution: { expected_signals: ['s'], final_answer: '42' },
        student_image_refs: [],
        step_weight: 1.5,
      }),
    ).toThrow();
  });
});

describe('StepsLlmOutput', () => {
  it('parses well-formed LLM output', () => {
    const parsed = StepsLlmOutput.parse({
      extracted_steps: [{ idx: 0, content: '∫2x dx = x²', verdict: 'correct', comment: 'ok' }],
      extracted_final_answer: 'x² + 3x + C',
      signal_verdicts: [{ signal_idx: 0, verdict: 'correct', comment: 'shows power rule' }],
      final_answer_match: true,
      final_answer_comment: 'matches',
      confidence: 0.92,
    });
    expect(parsed.signal_verdicts[0].verdict).toBe('correct');
    expect(parsed.confidence).toBe(0.92);
  });

  it('rejects invalid verdict enum value', () => {
    expect(() =>
      StepsLlmOutput.parse({
        extracted_steps: [],
        extracted_final_answer: '',
        signal_verdicts: [{ signal_idx: 0, verdict: 'maybe', comment: '' }],
        final_answer_match: false,
        final_answer_comment: '',
        confidence: 0.5,
      }),
    ).toThrow();
  });
});

describe('stepsV1Capability manifest', () => {
  it('has expected identity + cost class', () => {
    expect(stepsV1Capability.manifest.id).toBe('steps');
    expect(stepsV1Capability.manifest.version).toBe('1.0.0');
    expect(stepsV1Capability.manifest.kind).toBe('judge');
    expect(stepsV1Capability.manifest.cost_class).toBe('expensive_llm');
    expect(stepsV1Capability.manifest.stability).toBe('experimental');
  });

  it('run() returns unsupported skeleton response (M2.1 placeholder)', () => {
    const result = stepsV1Capability.run({
      question: { foo: 'bar' },
      answer: { content: 'student answer' },
    });
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.score_meaning).toBe('steps_v1_weighted');
    expect(result.capability_ref).toEqual({ id: 'steps', version: '1.0.0' });
    expect(result.feedback_md).toContain('M2.2');
  });
});
