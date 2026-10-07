import { z } from 'zod';
import { ApiError } from '@/kernel/http';
import type { DomainTool } from './types';

export const SubmitReviewAnswerInputSchema = z
  .object({
    submission_id: z.string().min(1),
    issuance_id: z.string().min(1),
    evaluation_group_id: z.string().min(1),
  })
  .strict();

/**
 * ToolContext currently has no authenticated original-submission authority.
 * An immutable assessment_submission or a user/self attempt alone cannot grant
 * it: the capture writer fixes that actor, and assistance absence means independent.
 * Keep this entry closed until a real server consumer binds ownership, issuance
 * coordinates and permission to the original. Do not create a second capture path.
 */
export const submitReviewAnswerTool: DomainTool<
  z.infer<typeof SubmitReviewAnswerInputSchema>,
  never
> = {
  name: 'submit_review_answer',
  description:
    'Requires an authenticated learner original and explicit server submission authorization. Currently unavailable: ask the learner to submit through the review page. Never supply a generated answer or claim user/self/independent authority.',
  effect: 'write',
  inputSchema: SubmitReviewAnswerInputSchema,
  outputSchema: z.never(),
  costClass: 'local',
  mirrorEvent: 'never',
  async execute(_ctx, input) {
    SubmitReviewAnswerInputSchema.parse(input);
    throw new ApiError(
      'user_submission_required',
      'Submit the learner original through the authenticated review page; this tool has no trusted original-submission authorization.',
      409,
    );
  },
  summarize() {
    return 'Learner submission required';
  },
};
