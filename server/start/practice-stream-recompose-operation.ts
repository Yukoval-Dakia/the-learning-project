import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const recomposeStartPracticeStream: FrontdoorContext['recomposePracticeStream'] = () =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { recomposePracticeStream } = await import('@/capabilities/practice/public');
      const { db } = await import('@/db/client');
      // The live client sends no body; the retained HTTP adapter resolves it to {}.
      return await recomposePracticeStream(db, {});
    } catch (error) {
      throw errorResponse(error);
    }
  });
