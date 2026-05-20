import { questionRef, type ActivityRefT } from '@/core/schema/activity';
import { ApiError } from '@/server/http/errors';

export interface ReviewSubmitIdentityInput {
  activity_ref?: ActivityRefT | null;
  question_id?: string | null;
  mistake_id?: string | null;
}

export interface NormalizedReviewSubmitActivityRef {
  activity_ref: ActivityRefT;
  question_id: string;
}

export function normalizeReviewSubmitActivityRef(
  input: ReviewSubmitIdentityInput,
): NormalizedReviewSubmitActivityRef {
  const activityRef = input.activity_ref ?? null;
  if (activityRef && activityRef.kind !== 'question') {
    throw new ApiError(
      'unsupported_activity_kind',
      `review submit currently supports question activities only; got ${activityRef.kind}`,
      400,
    );
  }

  const candidateIds = [
    activityRef?.id ?? null,
    input.question_id ?? null,
    input.mistake_id ?? null,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (candidateIds.length === 0) {
    throw new ApiError(
      'validation_error',
      'activity_ref, question_id, or mistake_id is required',
      400,
    );
  }

  const [questionId] = candidateIds;
  if (candidateIds.some((id) => id !== questionId)) {
    throw new ApiError(
      'validation_error',
      'activity_ref.id, question_id, and mistake_id must reference the same question',
      400,
    );
  }

  return {
    activity_ref: questionRef(questionId),
    question_id: questionId,
  };
}
