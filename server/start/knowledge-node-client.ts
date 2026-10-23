import type { KnowledgeClient } from '@/capabilities/knowledge/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartKnowledgeNodePage } from './knowledge-node-function';

export const startKnowledgeNodePageClient: KnowledgeClient['getNodePage'] = async (id) =>
  JSON.parse(await getStartKnowledgeNodePage({ fetch: authenticatedStartFetch, data: id }));
