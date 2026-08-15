import {
  SearchMemoryFactsInputSchema,
  buildSearchMemoryFactsTool,
  searchMemoryFactsTool,
} from '@/capabilities/copilot/server/tools/search-memory-facts';
import type { ToolContext } from '@/kernel/tools/types';
import type { MemoryReadClient } from '@/server/memory/read';
import { describe, expect, it, vi } from 'vitest';

// DI-pure: the smallest read-client adapter stands in for Mem0/pgvector, so no
// provider env or live vector store is touched. Only search is load-bearing for
// this read-only tool.
function stubClient(search: MemoryReadClient['search'] = vi.fn(async () => ({ results: [] }))): {
  client: MemoryReadClient;
  search: MemoryReadClient['search'];
} {
  const client = { search };
  return { client, search };
}

const ctx: ToolContext = {
  db: {} as ToolContext['db'],
  taskRunId: 'run_test',
  providerAttemptCaller: 'worker',
  providerSessionDeadlineAt: new Date('2026-08-09T03:01:00.000Z').getTime(),
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

    expect(search).toHaveBeenCalledWith(
      'what should I remember?',
      {
        topK: 15, // 5 × OVERFETCH_FACTOR(3)
        filters: { NOT: [{ superseded_by: '*' }] },
      },
      expect.objectContaining({
        caller: 'worker',
        deadlineAt: new Date('2026-08-09T03:01:00.000Z'),
        operationId: expect.any(String),
      }),
    );
  });

  it('threads scopeKey into the documented { scope_key } filter shape (merged with NOT-superseded)', async () => {
    const search = vi.fn(async () => ({ results: [] }));
    const { client } = stubClient(search);
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => client });

    await tool.execute(ctx, { query: 'subject prefs', scopeKey: 'topic:k1' });

    // topK omitted → DEFAULT_FACTS_TOP_K(10) × OVERFETCH_FACTOR(3) = 30
    expect(search).toHaveBeenCalledWith(
      'subject prefs',
      {
        topK: 30,
        filters: { scope_key: 'topic:k1', NOT: [{ superseded_by: '*' }] },
      },
      expect.objectContaining({ caller: 'worker' }),
    );
  });

  it('reuses operation identity for the same task and canonical input replay', async () => {
    // Given one task invocation and two equivalent forms of the default topK input.
    const operationIds: string[] = [];
    const search: MemoryReadClient['search'] = vi.fn(async (_query, _opts, operation) => {
      operationIds.push(operation.operationId);
      return { results: [] };
    });
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => stubClient(search).client });

    // When the same input is replayed with implicit and explicit defaults.
    await tool.execute(ctx, { query: 'stable replay' });
    await tool.execute(ctx, { query: 'stable replay', topK: 10 });

    // Then the opaque operation identity is stable and contains no query plaintext.
    expect(operationIds).toHaveLength(2);
    expect(operationIds[0]).toBe(operationIds[1]);
    expect(operationIds[0]).not.toContain('stable replay');
  });

  it('separates different canonical inputs within one task run', async () => {
    // Given one task run whose tool executes with two distinct scope/query inputs.
    const operationIds: string[] = [];
    const search: MemoryReadClient['search'] = vi.fn(async (_query, _opts, operation) => {
      operationIds.push(operation.operationId);
      return { results: [] };
    });
    const tool = buildSearchMemoryFactsTool({ memoryFactory: () => stubClient(search).client });

    // When both canonical inputs execute.
    await tool.execute(ctx, { query: 'first input', scopeKey: 'topic:first' });
    await tool.execute(ctx, { query: 'second input', scopeKey: 'topic:second' });

    // Then they cannot conflate into one operation.
    expect(new Set(operationIds)).toHaveLength(2);
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
