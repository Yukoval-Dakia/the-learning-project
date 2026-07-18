import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getNodePage: vi.fn() }));

vi.mock('./knowledge-api', () => ({ getNodePage: mocks.getNodePage }));

import {
  KNOWLEDGE_NODE_DRAWER_STALE_TIME_MS,
  knowledgeNodeDrawerQueryOptions,
  knowledgeNodeQueryOptions,
} from './knowledge-node-query';

describe('knowledgeNodeDrawerQueryOptions', () => {
  beforeEach(() => {
    mocks.getNodePage.mockReset().mockResolvedValue({ id: 'kc_1' });
  });

  it('gives repeated drawer opens a bounded freshness window', async () => {
    const baseOptions = knowledgeNodeQueryOptions('kc_1');
    const options = knowledgeNodeDrawerQueryOptions('kc_1');

    expect(baseOptions.queryKey).toEqual(options.queryKey);
    expect(baseOptions.staleTime).toBeUndefined();
    expect(options.queryKey).toEqual(['knowledge-node', 'kc_1']);
    expect(options.staleTime).toBe(60_000);
    expect(options.staleTime).toBe(KNOWLEDGE_NODE_DRAWER_STALE_TIME_MS);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await client.fetchQuery(options);
    await client.fetchQuery(options);

    expect(mocks.getNodePage).toHaveBeenCalledTimes(1);
  });
});
