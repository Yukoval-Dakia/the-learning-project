import type { MemoryClient } from '@/server/memory/client';
import { describe, expect, it, vi } from 'vitest';
import {
  SearchMemoryFactsInputSchema,
  buildSearchMemoryFactsTool,
  searchMemoryFactsTool,
} from './search-memory-facts';
import type { ToolContext } from './types';

// DI-pure: a stub MemoryClient stands in for the real Mem0/pgvector client, so
// no env (XIAOMI/OPENAI keys) or live vector store is touched (plan §62 / R10).
function stubClient(search: MemoryClient['search'] = vi.fn(async () => ({ results: [] }))): {
  client: MemoryClient;
  search: MemoryClient['search'];
} {
  const client: MemoryClient = {
    addEventMemory: vi.fn(async () => ({ results: [] })),
    search,
  };
  return { client, search };
}

const ctx: ToolContext = {
  db: {} as ToolContext['db'],
  taskRunId: 'run_test',
  callerActor: { kind: 'agent', ref: 'agent:coach' },
};

describe('searchMemoryFactsTool', () => {
  it('declares a read-only, never-mirrored, cheap_llm contract', () => {
    expect(searchMemoryFactsTool.name).toBe('search_memory_facts');
    expect(searchMemoryFactsTool.effect).toBe('read');
    expect(searchMemoryFactsTool.mirrorEvent).toBe('never');
    expect(searchMemoryFactsTool.costClass).toBe('cheap_llm');
  });

  // P3 (YUK-351): reads now flow through the searchMemories wrapper, so the
  // underlying client.search is called with an OVERFETCHED topK (topK × 3) and the
  // NOT-superseded filter merged in (then the wrapper reranks + truncates to topK).
  it('reads through searchMemories: overfetches topK × 3 with the NOT-superseded filter; no scope filter when scopeKey omitted', async () => {
    const search = vi.fn(async () => ({
      results: [{ id: 'm1', memory: 'prefers terse feedback' }],
    }));
    const { client } = stubClient(search);
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => client });

    await tool.execute(ctx, { query: 'what should I remember?', topK: 5 });

    expect(search).toHaveBeenCalledWith('what should I remember?', {
      topK: 15, // 5 × OVERFETCH_FACTOR(3)
      filters: { NOT: [{ superseded_by: '*' }] },
    });
  });

  it('threads scopeKey into the documented { scope_key } filter shape (merged with NOT-superseded)', async () => {
    const search = vi.fn(async () => ({ results: [] }));
    const { client } = stubClient(search);
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => client });

    await tool.execute(ctx, { query: 'subject prefs', scopeKey: 'topic:k1' });

    // topK omitted → DEFAULT_FACTS_TOP_K(10) × OVERFETCH_FACTOR(3) = 30
    expect(search).toHaveBeenCalledWith('subject prefs', {
      topK: 30,
      filters: { scope_key: 'topic:k1', NOT: [{ superseded_by: '*' }] },
    });
  });

  it('filters soft-superseded facts out of the tool result (P2 reconcile marker)', async () => {
    const search = vi.fn(async () => ({
      results: [
        {
          id: 'live',
          memory: 'prefers terse feedback',
          score: 0.8,
          metadata: { kind: 'preference' },
        },
        {
          id: 'dead',
          memory: 'prefers verbose feedback',
          score: 0.9,
          metadata: { kind: 'preference', superseded_by: 'live' },
        },
      ],
    }));
    const { client } = stubClient(search);
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => client });

    const out = await tool.execute(ctx, { query: 'feedback' });

    expect(out.count).toBe(1);
    expect(out.facts.map((f) => f.id)).toEqual(['live']);
  });

  it('maps Mem0 results into { facts, count } and preserves extra fields via passthrough', async () => {
    const search = vi.fn(async () => ({
      results: [
        { id: 'm1', memory: 'likes worked examples', score: 0.9, metadata: { source: 'event' } },
        { id: 'm2', memory: 'struggles with 通假字', score: 0.7 },
      ],
    }));
    const { client } = stubClient(search);
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => client });

    const out = await tool.execute(ctx, { query: 'study habits' });

    expect(out.count).toBe(2);
    expect(out.facts).toHaveLength(2);
    expect(out.facts[0]).toMatchObject({
      id: 'm1',
      memory: 'likes worked examples',
      score: 0.9,
      metadata: { source: 'event' },
    });
    expect(tool.summarize({ query: 'study habits' }, out)).toBe(
      'memory facts · "study habits" · 2 hits',
    );
  });

  it('tolerates a client returning no results array (soft-fail → empty, count 0)', async () => {
    const search = vi.fn(async () => ({ results: [] }));
    const { client } = stubClient(search);
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => client });

    const out = await tool.execute(ctx, { query: 'anything' });
    expect(out).toEqual({ facts: [], count: 0 });
  });

  it('constructs the memory client lazily (factory only invoked on execute)', async () => {
    const factory = vi.fn(() => stubClient().client);
    const tool = buildSearchMemoryFactsTool({ memoryFactory: factory });
    expect(factory).not.toHaveBeenCalled(); // building the tool must not touch env
    await tool.execute(ctx, { query: 'x' });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty query at the input schema (min(1))', () => {
    expect(SearchMemoryFactsInputSchema.safeParse({ query: '' }).success).toBe(false);
    expect(SearchMemoryFactsInputSchema.safeParse({ query: 'ok' }).success).toBe(true);
    // topK is bounded 1..20
    expect(SearchMemoryFactsInputSchema.safeParse({ query: 'ok', topK: 0 }).success).toBe(false);
    expect(SearchMemoryFactsInputSchema.safeParse({ query: 'ok', topK: 21 }).success).toBe(false);
  });
});
