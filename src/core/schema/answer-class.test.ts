import { describe, expect, it } from 'vitest';
import { ANSWER_CLASSES, deriveAnswerClass } from './answer-class';

describe('deriveAnswerClass', () => {
  it('choices present → exact (structure-first, regardless of kind)', () => {
    expect(deriveAnswerClass({ kind: 'short_answer', choices_md: ['A', 'B'] })).toBe('exact');
    expect(deriveAnswerClass({ kind: 'essay', choices_md: ['是', '否'] })).toBe('exact');
    expect(deriveAnswerClass({ kind: 'computation', choices_md: ['1', '2'] })).toBe('exact');
  });

  it('choice / true_false → exact', () => {
    expect(deriveAnswerClass({ kind: 'choice' })).toBe('exact');
    expect(deriveAnswerClass({ kind: 'true_false' })).toBe('exact');
  });

  it('fill_blank → keyword iff keywords else exact', () => {
    expect(deriveAnswerClass({ kind: 'fill_blank' })).toBe('exact');
    expect(
      deriveAnswerClass({ kind: 'fill_blank', rubric_json: { criteria: [], keywords: ['甲'] } }),
    ).toBe('keyword');
    // blank-only keywords don't count
    expect(
      deriveAnswerClass({ kind: 'fill_blank', rubric_json: { criteria: [], keywords: ['  '] } }),
    ).toBe('exact');
  });

  it('computation → keyword iff keywords else semantic', () => {
    expect(deriveAnswerClass({ kind: 'computation' })).toBe('semantic');
    expect(
      deriveAnswerClass({ kind: 'computation', rubric_json: { criteria: [], keywords: ['x'] } }),
    ).toBe('keyword');
  });

  it('derivation → steps (verification class)', () => {
    expect(deriveAnswerClass({ kind: 'derivation' })).toBe('steps');
  });

  it('prose kinds → semantic', () => {
    for (const kind of ['short_answer', 'reading', 'translation', 'essay'] as const) {
      expect(deriveAnswerClass({ kind })).toBe('semantic');
    }
  });

  it('empty choices_md is not treated as a choice item', () => {
    expect(deriveAnswerClass({ kind: 'short_answer', choices_md: [] })).toBe('semantic');
    expect(deriveAnswerClass({ kind: 'short_answer', choices_md: null })).toBe('semantic');
  });

  it('ANSWER_CLASSES is exactly the 4-value verification set', () => {
    expect([...ANSWER_CLASSES].sort()).toEqual(['exact', 'keyword', 'semantic', 'steps']);
  });
});
