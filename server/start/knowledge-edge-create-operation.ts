import { errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';
import type { FrontdoorContext } from './context';

export const createStartKnowledgeEdge: FrontdoorContext['createKnowledgeEdge'] = (body) =>
  runWithHttpProviderSessionDeadline(Date.now() + HTTP_PROVIDER_SESSION_BUDGET_MS, async () => {
    try {
      let raw: unknown = null;
      try {
        raw = JSON.parse(body);
      } catch {
        // Match the retained HTTP adapter: malformed JSON reaches the shared schema as null.
      }
      const { createManualKnowledgeEdge } = await import('@/capabilities/knowledge/public');
      const { db } = await import('@/db/client');
      return await createManualKnowledgeEdge(db, raw);
    } catch (error) {
      throw errorResponse(error);
    }
  });
