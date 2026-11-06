import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
export const createStartLearningIntent = (body: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    const agency = await import('@/capabilities/agency/public');
    try {
      const { db } = await import('@/db/client');
      return await agency.requestLearningIntent(db, async () => JSON.parse(body));
    } catch (error) {
      throw agency.learningIntentErrorResponse(error);
    }
  });
