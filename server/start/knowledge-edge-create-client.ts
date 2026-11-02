import type { KnowledgeClient } from '@/capabilities/knowledge/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { createStartKnowledgeEdgeFunction } from './knowledge-edge-create-function';

export const startKnowledgeEdgeCreateClient: KnowledgeClient['createEdge'] = async (input) =>
  JSON.parse(
    await createStartKnowledgeEdgeFunction({
      fetch: authenticatedStartFetch,
      data: JSON.stringify(input),
    }),
  );
