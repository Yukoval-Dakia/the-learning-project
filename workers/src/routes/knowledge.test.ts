import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { knowledge } from './knowledge';

function mockEnv(
  allRows: Record<string, unknown>[] = [],
  proposalRows: Record<string, unknown>[] = [],
  opts: { forceZeroChangesOnUpdate?: RegExp } = {},
) {
  const knowledgeTable: Record<string, Record<string, unknown>> = {};
  for (const r of allRows) knowledgeTable[r.id as string] = r;
  const proposalTable: Record<string, Record<string, unknown>> = {};
  for (const r of proposalRows) proposalTable[r.id as string] = r;

  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          if (/from dreaming_proposal where id = \?/i.test(sql)) {
            return proposalTable[binds[0] as string] ?? null;
          }
          if (/select id from knowledge where id = \?/i.test(sql)) {
            return knowledgeTable[binds[0] as string] ?? null;
          }
          return null;
        },
        all: async () => {
          if (/from knowledge/i.test(sql)) {
            return { results: Object.values(knowledgeTable) };
          }
          if (/from dreaming_proposal/i.test(sql)) {
            // honor status filter if present in SQL+binds
            const statusFilter = /status = \?/.test(sql)
              ? (binds[binds.length - 1] as string)
              : null;
            const results = Object.values(proposalTable).filter(
              (r) => statusFilter === null || r.status === statusFilter,
            );
            return { results };
          }
          if (/from mistake/i.test(sql)) {
            return { results: [] };
          }
          return { results: [] };
        },
        run: async () => {
          if (opts.forceZeroChangesOnUpdate?.test(sql)) {
            return { success: true, meta: { changes: 0 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
    },
  }));
  const db = {
    prepare,
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      const results: unknown[] = [];
      for (const s of stmts) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
  const images = { put: vi.fn(async () => null) } as unknown as R2Bucket;
  return {
    Bindings: { DB: db, IMAGES: images, INTERNAL_TOKEN: 'test', ANTHROPIC_API_KEY: 'test' },
    calls,
  };
}

describe('GET /api/knowledge', () => {
  it('returns full tree with effective_domain pre-computed', async () => {
    const { Bindings } = mockEnv([
      { id: 'k1', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null },
      { id: 'k2', name: '之', domain: null, parent_id: 'k1', archived_at: null },
    ]);
    const res = await knowledge.request('/', { method: 'GET' }, { ...Bindings });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; effective_domain: string }> };
    expect(body.rows).toHaveLength(2);
    const k1 = body.rows.find((r) => r.id === 'k1');
    const k2 = body.rows.find((r) => r.id === 'k2');
    expect(k1?.effective_domain).toBe('wenyan');
    expect(k2?.effective_domain).toBe('wenyan');
  });
});

describe('GET /api/knowledge/proposals', () => {
  it('returns pending proposals (default)', async () => {
    const { Bindings } = mockEnv(
      [],
      [
        {
          id: 'p1',
          kind: 'knowledge',
          payload: '{}',
          reasoning: 'r',
          status: 'pending',
          proposed_at: 1700000000,
          decided_at: null,
        },
        {
          id: 'p2',
          kind: 'knowledge',
          payload: '{}',
          reasoning: 'r',
          status: 'accepted',
          proposed_at: 1700000000,
          decided_at: 1700001000,
        },
      ],
    );
    const res = await knowledge.request('/proposals', { method: 'GET' }, { ...Bindings });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; status: string }> };
    // only pending should come back
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('p1');
  });
});

describe('POST /api/knowledge/proposals/:id/decide', () => {
  it('rejects with 400 if decision missing', async () => {
    const { Bindings } = mockEnv();
    const res = await knowledge.request(
      '/proposals/p1/decide',
      { method: 'POST', body: JSON.stringify({}), headers: { 'content-type': 'application/json' } },
      { ...Bindings },
    );
    expect(res.status).toBe(400);
  });

  it('accepts a pending propose_new proposal', async () => {
    const { Bindings, calls } = mockEnv(
      [
        {
          id: 'seed:wenyan:shici',
          name: '诗词',
          domain: 'wenyan',
          parent_id: null,
          archived_at: null,
        },
      ],
      [
        {
          id: 'p1',
          kind: 'knowledge',
          payload: JSON.stringify({
            mutation: 'propose_new',
            name: '通假字',
            parent_id: 'seed:wenyan:shici',
          }),
          reasoning: 'r',
          status: 'pending',
          proposed_at: 1700000000,
          decided_at: null,
        },
      ],
    );
    const res = await knowledge.request(
      '/proposals/p1/decide',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'accept' }),
        headers: { 'content-type': 'application/json' },
      },
      { ...Bindings },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe('propose_new_applied');
    expect(calls.some((c) => /insert into knowledge/i.test(c.sql))).toBe(true);
  });

  it('dismisses a pending proposal', async () => {
    const { Bindings, calls } = mockEnv(
      [],
      [
        {
          id: 'p2',
          kind: 'knowledge',
          payload: JSON.stringify({ mutation: 'propose_new', name: 'x', parent_id: null }),
          reasoning: 'r',
          status: 'pending',
          proposed_at: 1700000000,
          decided_at: null,
        },
      ],
    );
    const res = await knowledge.request(
      '/proposals/p2/decide',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'reject' }),
        headers: { 'content-type': 'application/json' },
      },
      { ...Bindings },
    );
    expect(res.status).toBe(200);
    const update = calls.find((c) => /update dreaming_proposal/i.test(c.sql));
    expect(update?.binds[0]).toBe('dismissed');
  });

  it('returns 409 when underlying mutation is stale', async () => {
    const { Bindings } = mockEnv(
      [{ id: 'k_node', name: 'X', domain: null, parent_id: 'k_p1', archived_at: null, version: 5 }],
      [
        {
          id: 'p_stale',
          kind: 'knowledge',
          payload: JSON.stringify({
            mutation: 'archive',
            node_id: 'k_node',
            expected_version: 5,
          }),
          reasoning: 'r',
          status: 'pending',
          proposed_at: 1700000000,
          decided_at: null,
        },
      ],
      { forceZeroChangesOnUpdate: /update knowledge/i },
    );
    const res = await knowledge.request(
      '/proposals/p_stale/decide',
      {
        method: 'POST',
        body: JSON.stringify({ decision: 'accept' }),
        headers: { 'content-type': 'application/json' },
      },
      { ...Bindings },
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('stale');
  });
});

describe('POST /api/knowledge/review', () => {
  it('hits the wired handler (does not 404)', async () => {
    const { Bindings } = mockEnv(
      [
        {
          id: 'k1',
          name: '虚词',
          domain: 'wenyan',
          parent_id: null,
          archived_at: null,
          version: 0,
        },
      ],
      [],
    );
    // Real LLM call would happen via streamReviewTask → streamTask → anthropic provider
    // (no network in test env). We don't inject a mock model here (router doesn't expose
    // that override). Deep streaming behavior is covered by review.test.ts (Task 8) using
    // MockLanguageModelV3.
    //
    // For the router test, we only assert: handler is mounted (not 404). The eventual
    // status may be 500 because the LLM call fails — that's fine, the handler ran.
    const res = await knowledge.request(
      '/review',
      { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      { ...Bindings },
    );
    expect(res.status).not.toBe(404);
  });
});
