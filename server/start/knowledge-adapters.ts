// Start-side adapters for this family. `frontdoor.ts` loads this module from the API
// graph, so every adapter below runs with the initialized subject registry, config
// snapshot and database pool; each keeps its own conversion, error and deadline handling.

import { ApiError, errorResponse } from '@/kernel/http';
import {
  HTTP_PROVIDER_SESSION_BUDGET_MS,
  runWithHttpProviderSessionDeadline,
} from '@/server/http/provider-session-deadline';

export const createStartKnowledgeEdge = (body: string) =>
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

export const readStartKnowledgeEdges = async (subject: string | undefined) => {
  try {
    const { readKnowledgeEdges } = await import('@/capabilities/knowledge/public');
    const { db } = await import('@/db/client');
    return await readKnowledgeEdges(db, { subject: subject || undefined });
  } catch (error) {
    throw errorResponse(error);
  }
};

export const readStartKnowledgeMisconceptions = async (id: string) => {
  try {
    const { KnowledgeIdParamsSchema, loadMisconceptionsForKc } = await import(
      '@/capabilities/knowledge/public'
    );
    const parsed = KnowledgeIdParamsSchema.safeParse({ id });
    if (!parsed.success) {
      throw new ApiError('validation_error', 'knowledge id is required', 400);
    }
    const { db } = await import('@/db/client');
    return { rows: await loadMisconceptionsForKc(db, parsed.data.id) };
  } catch (error) {
    throw errorResponse(error);
  }
};

export const readStartKnowledgeNodePage = async (id: string) => {
  try {
    const { readLearnerKnowledgeNodePage } = await import('@/capabilities/knowledge/public');
    const { db } = await import('@/db/client');
    return await readLearnerKnowledgeNodePage(db, { id });
  } catch (error) {
    throw errorResponse(error);
  }
};

export const readStartKnowledgeEntityCard = async (id: string) => {
  try {
    const { readKnowledgeEntityCard } = await import('@/capabilities/knowledge/public');
    const { db } = await import('@/db/client');
    return await readKnowledgeEntityCard(db, id);
  } catch (error) {
    throw errorResponse(error);
  }
};

export const knowledgeAdapters = {
  createStartKnowledgeEdge,
  readStartKnowledgeEdges,
  readStartKnowledgeEntityCard,
  readStartKnowledgeMisconceptions,
  readStartKnowledgeNodePage,
};
