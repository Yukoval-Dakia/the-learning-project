import { MAX_HINT_COUNT, MAX_HINT_INDEX } from '@/core/schema/event/known';
import { describe, expect, it } from 'vitest';
import {
  DeleteQuestionQuerySchema,
  QuestionDetailQuerySchema,
  QuestionListQuerySchema,
  SolveSubmissionBodySchema,
} from './question-solve-contracts';

describe('question and solve route contracts', () => {
  it('keeps the detail reader clamp contract open above its cap', () => {
    expect(QuestionDetailQuerySchema.parse({ timeline_limit: '75' })).toEqual({
      timeline_limit: 75,
    });
  });

  it('requires an optimistic-lock version only for confirmed deletion', () => {
    expect(DeleteQuestionQuerySchema.safeParse({}).success).toBe(true);
    expect(DeleteQuestionQuerySchema.safeParse({ confirm: 'true' }).success).toBe(false);
    expect(DeleteQuestionQuerySchema.parse({ confirm: 'true', version: '0' })).toEqual({
      confirm: 'true',
      version: 0,
    });
  });

  it('retains mutually exclusive list modes in the declared query contract', () => {
    expect(
      QuestionListQuerySchema.safeParse({
        expand_root: 'q1',
        group_by_family: true,
      }).success,
    ).toBe(false);
  });

  it('distinguishes the inclusive hint count from the maximum hint index', () => {
    expect(MAX_HINT_COUNT).toBe(MAX_HINT_INDEX + 1);
    expect(SolveSubmissionBodySchema.safeParse({ hints_used: MAX_HINT_COUNT }).success).toBe(true);
    expect(SolveSubmissionBodySchema.safeParse({ hints_used: MAX_HINT_COUNT + 1 }).success).toBe(
      false,
    );
    expect(SolveSubmissionBodySchema.safeParse({ final_hint_level: MAX_HINT_INDEX }).success).toBe(
      true,
    );
    expect(
      SolveSubmissionBodySchema.safeParse({ final_hint_level: MAX_HINT_INDEX + 1 }).success,
    ).toBe(false);
  });
});
