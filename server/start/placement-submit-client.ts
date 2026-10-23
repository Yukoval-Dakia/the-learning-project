import type { PlacementClient } from '@/capabilities/onboarding/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { submitStartPlacementAnswerFunction } from './placement-submit-function';

export const startPlacementSubmitClient: PlacementClient['submitProbeAnswer'] = async (input) =>
  JSON.parse(
    await submitStartPlacementAnswerFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify({
        question_id: input.questionId,
        session_id: input.sessionId,
        assessment: input.assessment,
        rating: 'good',
        response_md: input.responseMd,
        referenced_knowledge_ids: input.referencedKnowledgeIds,
        answer_image_refs: input.answerImageRefs ?? [],
        auto_rate: true,
        latency_ms: input.latencyMs ?? null,
      }),
    }),
  );
