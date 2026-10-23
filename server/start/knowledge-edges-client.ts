import { type KnowledgeClient, projectKnowledgeEdges } from '@/capabilities/knowledge/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartKnowledgeEdges } from './knowledge-edges-function';

export const startKnowledgeEdgesClient: KnowledgeClient['getEdges'] = async (subject) =>
  projectKnowledgeEdges(
    JSON.parse(await getStartKnowledgeEdges({ fetch: authenticatedStartFetch, data: subject })),
  );
