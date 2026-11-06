// Start-side adapters for this family. `frontdoor.ts` loads this module from the API
// graph, so every adapter below runs with the initialized subject registry, config
// snapshot and database pool; each keeps its own conversion, error and deadline handling.

import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';

export const getStartPracticeStream = (knowledgeId?: string) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { getPracticeStream } = await import('@/capabilities/practice/scheduling/public');
      const { db } = await import('@/db/client');
      return await getPracticeStream(db, { date: 'today', kc: knowledgeId });
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const recomposeStartPracticeStream = () =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      const { recomposePracticeStream } = await import('@/capabilities/practice/scheduling/public');
      const { db } = await import('@/db/client');
      // The live client sends no body; the retained HTTP adapter resolves it to {}.
      return await recomposePracticeStream(db, {});
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const updateStartPracticeStreamItem = ({ id, body }: { id: string; body: string }) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown = null;
      try {
        raw = JSON.parse(body);
      } catch {
        // Preserve the HTTP adapter's malformed-JSON input to the shared schema.
      }
      const { updatePracticeStreamItem } = await import(
        '@/capabilities/practice/scheduling/public'
      );
      const { db } = await import('@/db/client');
      return await updatePracticeStreamItem(db, id, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });

export const practiceStreamAdapters = {
  getStartPracticeStream,
  recomposeStartPracticeStream,
  updateStartPracticeStreamItem,
};
