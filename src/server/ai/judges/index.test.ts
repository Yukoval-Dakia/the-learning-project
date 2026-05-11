import { describe, expect, it } from 'vitest';
import { judgeRouter } from './index';

describe('judgeRouter', () => {
  it('dispatches to judgeExact for kind=exact', () => {
    const r = judgeRouter({
      kind: 'exact',
      question: { reference: 'A' },
      answer: { content: 'A' },
    });
    expect(r.verdict).toBe('correct');
  });

  it('dispatches to judgeKeyword for kind=keyword', () => {
    const r = judgeRouter({
      kind: 'keyword',
      question: { keywords: ['A', 'B'] },
      answer: { content: 'A and B' },
    });
    expect(r.verdict).toBe('correct');
  });

  it('throws for unimplemented kinds', () => {
    expect(() =>
      judgeRouter({
        kind: 'semantic',
        question: { reference: 'A' },
        answer: { content: 'A' },
      }),
    ).toThrow(/not implemented/i);
  });
});
