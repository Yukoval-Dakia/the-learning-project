import { describe, expect, it } from 'vitest';
import { LegacyPaperSubmissionBodySchema, MAX_PAPER_ANSWER_CHARS } from './paper-contracts';

describe('paper submission input bounds (YUK-695)', () => {
  it('rejects answer text beyond the judge/event payload ceiling', () => {
    const parsed = LegacyPaperSubmissionBodySchema.safeParse({
      session_id: 'session_1',
      question_id: 'question_1',
      answer_md: 'x'.repeat(MAX_PAPER_ANSWER_CHARS + 1),
    });
    expect(parsed.success).toBe(false);
  });
});
