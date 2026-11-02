import type { LearningIntentProposalClient } from '@/capabilities/agency/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartLearningIntentFunction } from './learning-intent-function';

export const startLearningIntentClient: LearningIntentProposalClient = async (topic) =>
  JSON.parse(
    await createStartLearningIntentFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify({ topic }),
    }),
  );
