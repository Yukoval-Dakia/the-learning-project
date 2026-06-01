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
});
