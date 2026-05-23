import { describe, expect, it } from 'vitest';
import { judgeRouter } from './index';

describe('judgeRouter', () => {
  it('dispatches to judgeExact for kind=exact', async () => {
    const r = await judgeRouter({
      kind: 'exact',
      question: { reference: 'A' },
      answer: { content: 'A' },
    });
    expect(r.verdict).toBe('correct');
  });

  it('dispatches to judgeKeyword for kind=keyword', async () => {
    const r = await judgeRouter({
      kind: 'keyword',
      question: { keywords: ['A', 'B'] },
      answer: { content: 'A and B' },
    });
    expect(r.verdict).toBe('correct');
  });

  it('throws for unimplemented kinds', async () => {
    await expect(
      judgeRouter({
        kind: 'rubric',
        question: { reference: 'A' },
        answer: { content: 'A' },
      }),
    ).rejects.toThrow(/not implemented|not found/i);
  });
});
