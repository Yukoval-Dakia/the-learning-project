import type { SearchResult } from 'mem0ai/oss';
import { type MemoryClient, createMemoryClient } from './client';
import { type SearchMemoriesOpts, searchMemories } from './search-memories';

/** The smallest client surface required by the read-only memory path. */
export type MemoryReadClient = Pick<MemoryClient, 'search'>;

/** Injectable construction seam: callers need not know how the mem0 client is configured. */
export type MemoryReadClientFactory = () => MemoryReadClient;

/**
 * Read learner facts through the canonical filtering/reranking path.
 *
 * This seam belongs in `server/memory`, not `kernel`: client construction and vector search are
 * server-only IO. Keeping both operations behind one interface prevents capability callers from
 * coupling to the concrete mem0 client plus its search wrapper independently.
 */
export async function readMemoryFacts(
  query: string,
  opts: SearchMemoriesOpts,
  deps: { createClient?: MemoryReadClientFactory } = {},
): Promise<SearchResult> {
  const client = (deps.createClient ?? createMemoryClient)();
  return searchMemories(client, query, opts);
}
