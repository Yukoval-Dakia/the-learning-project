import { describe, expect, it, vi } from 'vitest';
import type { MemoryClient } from './client';
import { KIND_HALF_LIFE_DAYS, OVERFETCH_FACTOR, searchMemories } from './search-memories';

// P3 (YUK-351): the mem0 READ path wrapper. Sits over MemoryClient.search and
// (1) forwards the NOT-superseded filter, (2) drops any soft-superseded item the
// underlying store still returned (defense-in-depth — the P2 marker is
// `metadata.superseded_by`), (3) recency-reranks by per-kind half-life, then (4)
// truncates to topK. All assertions drive a stub client so the unit test never
// touches pgvector / embeddings.

type Item = {
  id: string;
  memory: string;
  score?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
};

function stubClient(
  items: Item[],
  capture?: { lastSearch?: Parameters<MemoryClient['search']>[1] },
) {
  const search = vi.fn(async (_query: string, opts?: Parameters<MemoryClient['search']>[1]) => {
    if (capture) capture.lastSearch = opts;
    return { results: items };
  });
  // Only `search` is exercised by the read wrapper.
  return { search } as unknown as MemoryClient;
}

describe('searchMemories', () => {
  it('returns non-superseded memories and filters out soft-superseded ones', async () => {
    const now = new Date('2026-06-18T00:00:00Z');
    const client = stubClient([
      {
        id: 'live1',
        memory: 'prefers terse feedback',
        score: 0.9,
        metadata: { kind: 'preference' },
      },
      {
        id: 'dead1',
        memory: 'prefers verbose feedback',
        score: 0.95, // higher raw score, but superseded → must be dropped
        metadata: {
          kind: 'preference',
          superseded_by: 'live1',
          invalid_at: '2026-06-17T00:00:00Z',
        },
      },
      { id: 'live2', memory: 'studies in the morning', score: 0.8, metadata: { kind: 'habit' } },
    ]);

    const out = await searchMemories(client, 'feedback preferences', { topK: 5, now });

    const ids = out.results.map((r) => r.id);
    expect(ids).toContain('live1');
    expect(ids).toContain('live2');
    expect(ids).not.toContain('dead1'); // soft-superseded dropped by the wrapper
    expect(out.results).toHaveLength(2);
  });

  it('forwards the NOT-superseded filter and overfetches topK before truncating', async () => {
    const now = new Date('2026-06-18T00:00:00Z');
    const capture: { lastSearch?: Parameters<MemoryClient['search']>[1] } = {};
    // 5 live items, topK=2 → after rerank only the top 2 survive truncation.
    const items: Item[] = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      memory: `fact ${i}`,
      score: 0.5 + i * 0.05,
      metadata: { kind: 'event', created_ms: now.getTime() }, // all same age → score order preserved
    }));
    const client = stubClient(items, capture);

    const out = await searchMemories(client, 'q', { topK: 2, now });

    // overfetch: request topK × OVERFETCH_FACTOR candidates from the store
    expect(capture.lastSearch?.topK).toBe(2 * OVERFETCH_FACTOR);
    // NOT-superseded filter forwarded to mem0 (uppercase NOT per design §3.3)
    expect(capture.lastSearch?.filters).toMatchObject({ NOT: [{ superseded_by: '*' }] });
    // truncated to topK
    expect(out.results).toHaveLength(2);
    // highest raw score wins when all ages equal
    expect(out.results[0]?.id).toBe('m4');
    expect(out.results[1]?.id).toBe('m3');
  });

  it('recency-reranks: a fresher lower-raw-score event can overtake a stale higher-score event', async () => {
    const now = new Date('2026-06-18T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    // event half-life is short; an item 4× the event half-life old is decayed to
    // ~1/16 of its raw score, so a same-raw-score fresh item ranks above it.
    const staleMs = now.getTime() - KIND_HALF_LIFE_DAYS.event * 4 * day;
    const client = stubClient([
      {
        id: 'stale',
        memory: 'old event',
        score: 0.9,
        metadata: { kind: 'event', created_ms: staleMs },
      },
      {
        id: 'fresh',
        memory: 'new event',
        score: 0.7,
        metadata: { kind: 'event', created_ms: now.getTime() },
      },
    ]);

    const out = await searchMemories(client, 'q', { topK: 2, now });

    // fresh (0.7 raw, no decay) beats stale (0.9 raw × ~0.0625 decay ≈ 0.056)
    expect(out.results[0]?.id).toBe('fresh');
    expect(out.results[1]?.id).toBe('stale');
  });

  it('preference half-life is longer than event half-life (per §3.6 kind decay)', () => {
    expect(KIND_HALF_LIFE_DAYS.preference).toBeGreaterThan(KIND_HALF_LIFE_DAYS.event);
    expect(KIND_HALF_LIFE_DAYS.habit).toBeGreaterThan(KIND_HALF_LIFE_DAYS.event);
  });

  it('merges caller filters with the NOT-superseded filter (scope_key passes through)', async () => {
    const now = new Date('2026-06-18T00:00:00Z');
    const capture: { lastSearch?: Parameters<MemoryClient['search']>[1] } = {};
    const client = stubClient(
      [
        {
          id: 'a',
          memory: 'x',
          score: 0.5,
          metadata: { kind: 'event', created_ms: now.getTime() },
        },
      ],
      capture,
    );

    await searchMemories(client, 'q', { topK: 3, now, filters: { scope_key: 'topic:k1' } });

    expect(capture.lastSearch?.filters).toMatchObject({
      scope_key: 'topic:k1',
      NOT: [{ superseded_by: '*' }],
    });
  });
});
