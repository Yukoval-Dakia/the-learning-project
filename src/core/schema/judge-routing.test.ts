import { describe, expect, it } from 'vitest';
import { PROSE_KINDS, defaultJudgeKindForQuestion, nonEmptyStrings } from './judge-routing';

describe('nonEmptyStrings', () => {
  it('trims and drops blank entries', () => {
    expect(nonEmptyStrings(['  a ', '', '  ', 'b'])).toEqual(['a', 'b']);
  });

  it('returns [] for undefined', () => {
    expect(nonEmptyStrings(undefined)).toEqual([]);
  });
});

describe('defaultJudgeKindForQuestion', () => {
  it('honours an explicit judge_kind_override', () => {
    expect(
      defaultJudgeKindForQuestion({ kind: 'short_answer', judge_kind_override: 'rubric' }),
    ).toBe('rubric');
  });

  it('routes choice / true_false to exact', () => {
    expect(defaultJudgeKindForQuestion({ kind: 'choice' })).toBe('exact');
    expect(defaultJudgeKindForQuestion({ kind: 'true_false' })).toBe('exact');
  });

  it('routes fill_blank to keyword only when keywords are present', () => {
    expect(defaultJudgeKindForQuestion({ kind: 'fill_blank' })).toBe('exact');
    expect(
      defaultJudgeKindForQuestion({
        kind: 'fill_blank',
        rubric_json: { criteria: [], keywords: ['甲'] },
      }),
    ).toBe('keyword');
  });

  it('routes computation to keyword when keywords present, else semantic', () => {
    expect(defaultJudgeKindForQuestion({ kind: 'computation' })).toBe('semantic');
    expect(
      defaultJudgeKindForQuestion({
        kind: 'computation',
        rubric_json: { criteria: [], keywords: ['x'] },
      }),
    ).toBe('keyword');
  });

  it('routes derivation to semantic (never exact)', () => {
    expect(defaultJudgeKindForQuestion({ kind: 'derivation' })).toBe('semantic');
  });

  it('routes prose kinds to semantic', () => {
    for (const kind of [...PROSE_KINDS]) {
      expect(defaultJudgeKindForQuestion({ kind })).toBe('semantic');
    }
  });

  it('routes any other kind to exact', () => {
    // essay is in PROSE_KINDS → semantic; anything not prose/derivation/etc → exact.
    expect(defaultJudgeKindForQuestion({ kind: 'essay' })).toBe('semantic');
  });
});
