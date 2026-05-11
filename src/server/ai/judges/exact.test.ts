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
