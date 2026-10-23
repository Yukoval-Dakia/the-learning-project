import type { PracticeClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { previewStartReviewAdviceFunction } from './practice-advice-function';

export const startPracticeAdviceClient: PracticeClient['getAdvice'] = async (
  questionId,
  responseMd,
  imageRefs,
  assessment,
) =>
  JSON.parse(
    await previewStartReviewAdviceFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify({
        assessment,
        question_id: questionId,
        response_md: responseMd,
        ...(imageRefs.length > 0 ? { answer_image_refs: [...imageRefs] } : {}),
      }),
    }),
  );
