import { z } from 'zod';
import { ApiError } from '@/kernel/http';
import type { DomainTool } from '@/kernel/tools/types';

const Input = z.object({ original_ref: z.string().min(1) }).strict();
export const ReviewAnswerReceiptSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pending'), run_id: z.string() }).strict(),
  z
    .object({
      kind: z.literal('committed'),
      status: z.enum(['effective', 'review_required']),
      submission_id: z.string(),
      attempt_id: z.string(),
      candidate_id: z.string(),
    })
    .strict(),
]);
export type ReviewAnswerReceipt = z.infer<typeof ReviewAnswerReceiptSchema>;

export const submitReviewAnswerTool: DomainTool<z.infer<typeof Input>, ReviewAnswerReceipt> = {
  name: 'submit_review_answer',
  description:
    'Submit the unchanged learner original attached and explicitly authorized in this chat turn. Use only the server-provided original_ref. Answers, actor identity and independence cannot be supplied by this tool.',
  effect: 'write',
  costClass: 'expensive_llm',
  inputSchema: Input,
  outputSchema: ReviewAnswerReceiptSchema,
  mirrorEvent: 'always',
  async execute(ctx, raw) {
    const input = Input.parse(raw);
    ctx.signal?.throwIfAborted();
    if (
      !ctx.reviewAnswer ||
      ctx.reviewAnswer.originalRef !== input.original_ref ||
      ctx.reviewAnswer.sessionId !== ctx.sessionId ||
      ctx.causedByEventId !== input.original_ref
    ) {
      throw new ApiError('review_answer_unbound', 'no authorized original for this turn', 403);
    }
    return ReviewAnswerReceiptSchema.parse(await ctx.reviewAnswer.submit());
  },
  summarize(_input, result) {
    return result.kind === 'pending'
      ? 'review answer · grading pending'
      : `review answer · ${result.status}`;
  },
};
