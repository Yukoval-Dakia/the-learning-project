import { describe, expect, it } from 'vitest';
import { SolutionGenerateOutput } from './solution';

describe('SolutionGenerateOutput', () => {
  it('parses a valid output', () => {
    const parsed = SolutionGenerateOutput.parse({
      reference_solution: {
        expected_signals: ['用平方差因式分解', '约去 a−b'],
        final_answer: 'a + b',
        answer_equivalents: ['a+b'],
      },
      worked_solution_md: '先因式分解，再约分。',
      confidence: 0.8,
    });
    expect(parsed.reference_solution.expected_signals).toHaveLength(2);
    expect(parsed.worked_solution_md).toContain('因式分解');
  });

  it('defaults answer_equivalents to [] when omitted', () => {
    const parsed = SolutionGenerateOutput.parse({
      reference_solution: { expected_signals: ['x'], final_answer: 'y' },
      worked_solution_md: 'z',
      confidence: 0.5,
    });
    expect(parsed.reference_solution.answer_equivalents).toEqual([]);
  });

  it('rejects empty expected_signals', () => {
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: { expected_signals: [], final_answer: 'y', answer_equivalents: [] },
        worked_solution_md: 'z',
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it('bounds the atomized complete path to twelve reasonably sized operations', () => {
    const base = {
      final_answer: '42',
      answer_equivalents: [],
    };
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: {
          ...base,
          expected_signals: Array.from({ length: 13 }, (_, index) => `必要步骤 ${index + 1}`),
        },
        worked_solution_md: '逐项完成并核对。',
        confidence: 0.9,
      }),
    ).toThrow();
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: { ...base, expected_signals: ['步'.repeat(1001)] },
        worked_solution_md: '逐项完成并核对。',
        confidence: 0.9,
      }),
    ).toThrow();
  });

  it('rejects empty final_answer', () => {
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: { expected_signals: ['x'], final_answer: '', answer_equivalents: [] },
        worked_solution_md: 'z',
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it('rejects empty worked_solution_md', () => {
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: { expected_signals: ['x'], final_answer: 'y', answer_equivalents: [] },
        worked_solution_md: '',
        confidence: 0.5,
      }),
    ).toThrow();
  });

  it('rejects an oversized worked solution at the shared validator boundary', () => {
    expect(() =>
      SolutionGenerateOutput.parse({
        reference_solution: {
          expected_signals: ['完整求解并核对最终答案'],
          final_answer: '42',
          answer_equivalents: [],
        },
        worked_solution_md: '推'.repeat(12_001),
        confidence: 0.91,
      }),
    ).toThrow();
  });
});
