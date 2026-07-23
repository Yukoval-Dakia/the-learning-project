import { describe, expect, it } from 'vitest';
import {
  CreatePaperSubmissionBodySchema,
  LegacyPaperSubmissionBodySchema,
  MAX_PAPER_ANSWER_CHARS,
} from './paper-contracts';

describe('paper submission input bounds (YUK-695, YUK-448)', () => {
  it('rejects answer text beyond the judge/event payload ceiling', () => {
    const parsed = LegacyPaperSubmissionBodySchema.safeParse({
      session_id: 'session_1',
      question_id: 'question_1',
      answer_md: 'x'.repeat(MAX_PAPER_ANSWER_CHARS + 1),
    });
    expect(parsed.success).toBe(false);
  });

  it.each([LegacyPaperSubmissionBodySchema, CreatePaperSubmissionBodySchema])(
    'accepts cumulative latency through the nonnegative safe-integer ceiling',
    (schema) => {
      const base = {
        question_id: 'question_1',
        answer_md: 'answer',
        latency_ms: Number.MAX_SAFE_INTEGER,
      };
      const body =
        schema === LegacyPaperSubmissionBodySchema
          ? { ...base, session_id: 'session_1' }
          : { ...base, paper_id: 'paper_1' };
      expect(schema.safeParse(body).success).toBe(true);
      expect(schema.safeParse({ ...body, latency_ms: -1 }).success).toBe(false);
      expect(schema.safeParse({ ...body, latency_ms: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(
        false,
      );
    },
  );
});
