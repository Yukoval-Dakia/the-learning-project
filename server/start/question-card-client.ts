import type { QuestionCardClient } from '@/capabilities/practice/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { startIssuanceCreateClient } from './issuance-create-client';
import { startIssuanceStateClient } from './issuance-state-client';
import { startPracticeAdviceClient } from './practice-advice-client';
import { startPracticeSubmitClient } from './practice-submit-client';
import { getStartQuestionCardFunction } from './question-card-function';
import { startResponseDraftClient } from './response-draft-client';

export const startQuestionCardClient: QuestionCardClient = {
  getQuestionCard: async (id, sessionId) =>
    JSON.parse(
      await getStartQuestionCardFunction({
        fetch: authenticatedStartFetch,
        data: { id, sessionId },
      }),
    ),
  issueAssessment: startIssuanceCreateClient,
  getIssuanceState: startIssuanceStateClient,
  saveResponseDraft: startResponseDraftClient,
  getAdvice: startPracticeAdviceClient,
  submitReview: startPracticeSubmitClient,
};
