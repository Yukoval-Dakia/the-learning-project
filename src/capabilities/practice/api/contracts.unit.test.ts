import { describe, expect, it } from 'vitest';
import { CreateAppealBodySchema, CreateAttemptBodySchema } from './contracts';

describe('practice attempt and appeal contracts', () => {
  it('keeps attempt defaults aligned with the route handler', () => {
    const body = CreateAttemptBodySchema.parse({ question_id: 'q1', rating: 'good' });

    expect(body.referenced_knowledge_ids).toEqual([]);
    expect(body.answer_image_refs).toEqual([]);
    expect(body.auto_rate).toBe(false);
  });

  it('validates appeal handles and the reason length cap', () => {
    expect(CreateAppealBodySchema.safeParse({ judge_event_id: 'judge_1' }).success).toBe(true);
    expect(CreateAppealBodySchema.safeParse({ judge_event_id: '' }).success).toBe(false);
    expect(
      CreateAppealBodySchema.safeParse({
        judge_event_id: 'judge_1',
        reason_md: 'x'.repeat(2001),
      }).success,
    ).toBe(false);
  });
});
