import { z } from 'zod';
import { SubmissionRecord } from '@/core/schema/assessment';
import { REASONING_TRACE_MAX_LEN } from '@/kernel/limits';

const OriginalSubmission = SubmissionRecord.omit({ revision_id: true, submitted_at: true }).extend({
  submission_id: z.string().min(1).optional(),
  group_evidence: SubmissionRecord.shape.group_evidence.default([]),
});

/** Only the authenticated request may attach an original and authorize submission. */
export const ReviewAnswerAttachmentSchema = z
  .object({
    authorize_submission: z.literal(true),
    question_id: z.string().min(1),
    assessment: OriginalSubmission.strict(),
    review_session_id: z.string().min(1).optional(),
    reasoning_trace: z.string().max(REASONING_TRACE_MAX_LEN).optional(),
  })
  .strict();
export type ReviewAnswerAttachment = z.infer<typeof ReviewAnswerAttachmentSchema>;

export const BoundReviewAnswerSchema = z
  .object({
    version: z.literal(1),
    original_ref: z.string().min(1),
    session_id: z.string().min(1),
    revision_id: z.string().min(1),
    submission_id: z.string().min(1),
    original_sha256: z.string().length(64),
    original: ReviewAnswerAttachmentSchema.extend({
      assessment: OriginalSubmission.omit({ response_set: true, group_evidence: true }).strict(),
    }).strict(),
  })
  .strict();
export type BoundReviewAnswer = z.infer<typeof BoundReviewAnswerSchema>;
