import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { rethrowStartAdviceError } from './practice-advice-error';
import { previewStartReviewAdviceFunction } from './practice-advice-function';

export const startPracticeAdviceClient: PracticeClient['getAdvice'] = async (
  questionId,
  responseMd,
  imageRefs,
  assessment,
  commit,
) => {
  try {
    return JSON.parse(
      await previewStartReviewAdviceFunction({
        fetch: authenticatedStartFetch,
        data: JSON.stringify({
          assessment,
          question_id: questionId,
          response_md: responseMd,
          accept_pending: true,
          ...(imageRefs.length > 0 ? { answer_image_refs: [...imageRefs] } : {}),
          ...(commit ? { commit } : {}),
        }),
      }),
    );
  } catch (error) {
    return rethrowStartAdviceError(error);
  }
};
