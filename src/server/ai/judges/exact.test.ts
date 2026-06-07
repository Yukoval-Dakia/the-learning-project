import { describe, expect, it } from 'vitest';
import { judgeExact } from './exact';

describe('judgeExact', () => {
  it('returns correct verdict on exact match', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '宾语前置' });
    expect(r.verdict).toBe('correct');
    expect(r.score).toBe(1);
  });

  it('returns incorrect on mismatch', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '主谓倒装' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('trims whitespace before comparing', () => {
    const r = judgeExact({ reference: '宾语前置' }, { content: '  宾语前置  ' });
    expect(r.verdict).toBe('correct');
  });

  it('case-insensitive for ASCII text', () => {
    const r = judgeExact({ reference: 'Yes' }, { content: 'yes' });
    expect(r.verdict).toBe('correct');
  });
});

describe('judgeExact — choice-aware judging (YUK-260)', () => {
  const choices = ['宾语前置', '主谓倒装', '定语后置', '状语后置'];

  it('① letter answer vs option-text reference → correct', () => {
    const r = judgeExact({ reference: '宾语前置', choices_md: choices }, { content: 'A' });
    expect(r.verdict).toBe('correct');
    expect(r.score).toBe(1);
  });

  it('② option-text answer vs letter reference → correct', () => {
    const r = judgeExact({ reference: 'A', choices_md: choices }, { content: '宾语前置' });
    expect(r.verdict).toBe('correct');
  });

  it('③ multi-select BC matches B、C / CB / full-width comma', () => {
    const cs = ['甲', '乙', '丙', '丁'];
    expect(judgeExact({ reference: 'BC', choices_md: cs }, { content: 'B、C' }).verdict).toBe(
      'correct',
    );
    expect(judgeExact({ reference: 'BC', choices_md: cs }, { content: 'CB' }).verdict).toBe(
      'correct',
    );
    expect(judgeExact({ reference: 'BC', choices_md: cs }, { content: 'B，C' }).verdict).toBe(
      'correct',
    );
  });

  it('④ wrong letter D vs A → incorrect', () => {
    const r = judgeExact({ reference: 'A', choices_md: choices }, { content: 'D' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('⑤ out-of-range letter (E with 4 options) falls back to text → incorrect', () => {
    const r = judgeExact({ reference: 'A', choices_md: choices }, { content: 'E' });
    expect(r.verdict).toBe('incorrect');
  });

  it('⑥ no choices_md → plain text equality (no regression)', () => {
    expect(judgeExact({ reference: '宾语前置' }, { content: 'A' }).verdict).toBe('incorrect');
    expect(judgeExact({ reference: '宾语前置' }, { content: '宾语前置' }).verdict).toBe('correct');
  });

  it('⑦ NFKC: full-width letter Ａ resolves to index 0', () => {
    const r = judgeExact(
      { reference: '宾语前置', choices_md: ['宾语前置', '主谓倒装'] },
      { content: 'Ａ' },
    );
    expect(r.verdict).toBe('correct');
  });

  it('⑧ empty answer string → no match, no crash', () => {
    const r = judgeExact({ reference: 'A', choices_md: ['宾语前置', '主谓倒装'] }, { content: '' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });
});
