import { describe, expect, it } from 'vitest';
import { judgeKeyword } from './keyword';

describe('judgeKeyword', () => {
  it('correct when all keywords hit', () => {
    const r = judgeKeyword(
      { keywords: ['宾语', '前置', '动词'] },
      { content: '宾语在动词前面，叫宾语前置' },
    );
    expect(r.verdict).toBe('correct');
    expect(r.score).toBe(1);
  });

  it('partial when some keywords hit', () => {
    const r = judgeKeyword({ keywords: ['宾语', '前置', '动词'] }, { content: '宾语前置' });
    expect(r.verdict).toBe('partial');
    expect(r.score).toBeCloseTo(2 / 3, 2);
  });

  it('incorrect when no keywords hit', () => {
    const r = judgeKeyword({ keywords: ['宾语', '前置'] }, { content: '主谓倒装' });
    expect(r.verdict).toBe('incorrect');
    expect(r.score).toBe(0);
  });

  it('feedback lists missing keywords', () => {
    const r = judgeKeyword({ keywords: ['A', 'B', 'C'] }, { content: 'has A only' });
    expect(r.feedback_md).toMatch(/缺失/);
    expect(r.feedback_md).toContain('B');
    expect(r.feedback_md).toContain('C');
  });
});
