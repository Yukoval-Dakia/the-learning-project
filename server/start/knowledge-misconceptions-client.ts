import type { KnowledgeClient } from '@/capabilities/knowledge/ui-public';
import { authenticatedStartFetch } from './authenticated-fetch';
import { getStartKnowledgeMisconceptions } from './knowledge-misconceptions-function';

export const startKnowledgeMisconceptionsClient: KnowledgeClient['getMisconceptions'] = async (
  id,
) =>
  JSON.parse(await getStartKnowledgeMisconceptions({ fetch: authenticatedStartFetch, data: id }));
