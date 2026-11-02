import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const readStartLibraryQuestionMistakes: FrontdoorContext['readLibraryQuestionMistakes'] = (
  id,
) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { readMistakes } = await import('@/capabilities/ingestion/public');
      const { db } = await import('@/db/client');
      return await readMistakes(db, { question_id: id, limit: '50' });
    } catch (error) {
      throw errorResponse(error);
    }
  });
