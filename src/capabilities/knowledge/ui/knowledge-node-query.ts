import { queryOptions } from '@tanstack/react-query';
import { getNodePage } from './knowledge-api';

// YUK-334 — only the graph drawer gets a short freshness window. Reopening the same drawer should
// reuse its payload, while the full detail route deliberately keeps staleTime=0 so navigation after
// a mutation still refetches even when a drawer populated the shared key moments earlier.
export const KNOWLEDGE_NODE_DRAWER_STALE_TIME_MS = 60_000;

export function knowledgeNodeDrawerQueryOptions(id: string) {
  return queryOptions({
    queryKey: ['knowledge-node', id] as const,
    queryFn: () => getNodePage(id),
    staleTime: KNOWLEDGE_NODE_DRAWER_STALE_TIME_MS,
  });
}
