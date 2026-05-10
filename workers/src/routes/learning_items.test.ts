import { describe, expect, it, vi } from 'vitest';
import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import { learningItems } from './learning_items';

type LearningItemRow = {
  id: string;
  title: string;
  content: string;
  knowledge_ids: string;
  status: string;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
};

type LearningItemMetaRow = {
  id: string;
  status: string;
  version: number;
  archived_at: number | null;
};

type LearningItemDeleteMetaRow = {
  id: string;
  version: number;
  archived_at: number | null;
};

type RunResult = { success?: boolean; meta?: { changes?: number } };

function mockEnv(opts: {
  learningItemRows?: LearningItemRow[];
  knownKnowledgeIds?: Set<string>;
  learningItemById?: Map<string, LearningItemMetaRow>;
  learningItemDeleteById?: Map<string, LearningItemDeleteMetaRow>;
  learningItemAfterUpdate?: LearningItemRow | null;
  updateResult?: RunResult;
} = {}) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const batchCalls: Array<{ stmts: Array<{ sql: string; binds: unknown[] }> }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      const wrapped = {
        __sql: sql,
        __binds: binds,
        first: async () => {
          if (/select id from knowledge where id = \? and archived_at is null/i.test(sql)) {
            const id = binds[0] as string;
            return opts.knownKnowledgeIds?.has(id) ? { id } : null;
          }
          if (/select id, status, version, archived_at from learning_item where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            return opts.learningItemById?.get(id) ?? null;
          }
          if (/select id, version, archived_at from learning_item where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            return opts.learningItemDeleteById?.get(id) ?? null;
          }
          if (
            /select id, title, content, knowledge_ids, status, completed_at, created_at, updated_at, version\s+from learning_item where id = \?/i.test(
              sql,
            )
          ) {
            return opts.learningItemAfterUpdate ?? null;
          }
          return null;
        },
        all: async () => {
          if (/from learning_item\s+where archived_at is null and status != 'dismissed'/i.test(sql)) {
            return { results: opts.learningItemRows ?? [] };
          }
          return { results: [] };
        },
        run: async (): Promise<RunResult> => {
          if (/^update learning_item/i.test(sql)) {
            return opts.updateResult ?? { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return wrapped;
    },
  }));
  const db = {
    prepare,
    batch: async (stmts: Array<{ __sql: string; __binds: unknown[] }>) => {
      batchCalls.push({ stmts: stmts.map((s) => ({ sql: s.__sql, binds: s.__binds })) });
      return [{ meta: { changes: 1 } }];
    },
  } as unknown as D1Database;
  const executionCtx = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    Bindings: {
      DB: db,
      IMAGES: { put: vi.fn(async () => null) } as unknown as R2Bucket,
      INTERNAL_TOKEN: 'test',
      ANTHROPIC_API_KEY: 'test',
    },
    executionCtx,
    calls,
    batchCalls,
  };
}

function makeRow(over: Partial<LearningItemRow> = {}): LearningItemRow {
  return {
    id: 'li1',
    title: 't',
    content: 'c',
    knowledge_ids: '["k1"]',
    status: 'pending',
    completed_at: null,
    created_at: 1700000000,
    updated_at: 1700000000,
    version: 0,
    ...over,
  };
}

describe('GET /api/learning-items', () => {
  it('default returns all non-archived non-dismissed in status priority order', async () => {
    const learningItemRows: LearningItemRow[] = [
      makeRow({ id: 'li_pending', status: 'pending', updated_at: 1700000003 }),
      makeRow({ id: 'li_in_progress', status: 'in_progress', updated_at: 1700000002 }),
      makeRow({ id: 'li_done', status: 'done', updated_at: 1700000001 }),
    ];
    const { Bindings, executionCtx } = mockEnv({ learningItemRows });
    const res = await learningItems.request('/', { method: 'GET' }, Bindings, executionCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; status: string }> };
    expect(body.rows).toHaveLength(3);
    expect(body.rows.map((r) => r.id)).toEqual(['li_pending', 'li_in_progress', 'li_done']);
  });

  it('status filter binds the value into the WHERE clause twice', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ learningItemRows: [] });
    await learningItems.request('/?status=pending', { method: 'GET' }, Bindings, executionCtx);
    const sql = calls[0]?.sql ?? '';
    expect(sql).toMatch(/\(\? is null or status = \?\)/i);
    const binds = calls[0]?.binds ?? [];
    const pendingCount = binds.filter((b) => b === 'pending').length;
    expect(pendingCount).toBe(2);
  });

  it('clamps limit to [1, 200] and falls back to 50 on NaN', async () => {
    {
      const { Bindings, executionCtx, calls } = mockEnv({ learningItemRows: [] });
      await learningItems.request('/?limit=999', { method: 'GET' }, Bindings, executionCtx);
      expect(calls[0]?.binds).toContain(200);
    }
    {
      const { Bindings, executionCtx, calls } = mockEnv({ learningItemRows: [] });
      await learningItems.request('/?limit=0', { method: 'GET' }, Bindings, executionCtx);
      expect(calls[0]?.binds).toContain(1);
    }
    {
      const { Bindings, executionCtx, calls } = mockEnv({ learningItemRows: [] });
      await learningItems.request('/?limit=abc', { method: 'GET' }, Bindings, executionCtx);
      expect(calls[0]?.binds).toContain(50);
    }
  });

  it('SQL contains the status priority CASE expression', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ learningItemRows: [] });
    await learningItems.request('/', { method: 'GET' }, Bindings, executionCtx);
    const sql = calls[0]?.sql ?? '';
    expect(sql).toMatch(/case status/i);
    expect(sql).toMatch(/when 'pending' then 0/i);
    expect(sql).toMatch(/when 'in_progress' then 1/i);
    expect(sql).toMatch(/when 'done' then 2/i);
  });
});

function jsonReq(body: unknown, method = 'POST') {
  return {
    method,
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

describe('POST /api/learning-items', () => {
  it('happy path: 200 + INSERT + response with pending/version 0/null completed_at', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ knownKnowledgeIds: new Set(['k1']) });
    const res = await learningItems.request(
      '/',
      jsonReq({ title: 'Title', content: 'C', knowledge_ids: ['k1'] }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      status: string;
      version: number;
      completed_at: number | null;
    };
    expect(body.id).toMatch(/.+/);
    expect(body.status).toBe('pending');
    expect(body.version).toBe(0);
    expect(body.completed_at).toBeNull();

    const insertCall = calls.find((c) => /^insert into learning_item/i.test(c.sql));
    expect(insertCall).toBeDefined();
    expect(insertCall?.binds).toContain('Title');
  });

  it('400 on missing title; no INSERT', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ knownKnowledgeIds: new Set() });
    const res = await learningItems.request('/', jsonReq({}), Bindings, executionCtx);
    expect(res.status).toBe(400);
    const insertCall = calls.find((c) => /^insert into learning_item/i.test(c.sql));
    expect(insertCall).toBeUndefined();
  });

  it('400 on title length > 200', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ knownKnowledgeIds: new Set() });
    const res = await learningItems.request(
      '/',
      jsonReq({ title: 'X'.repeat(201) }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
    const insertCall = calls.find((c) => /^insert into learning_item/i.test(c.sql));
    expect(insertCall).toBeUndefined();
  });

  it('400 on unknown knowledge_id; message contains the id; no INSERT', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ knownKnowledgeIds: new Set() });
    const res = await learningItems.request(
      '/',
      jsonReq({ title: 'T', knowledge_ids: ['k_missing'] }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/k_missing/);
    const insertCall = calls.find((c) => /^insert into learning_item/i.test(c.sql));
    expect(insertCall).toBeUndefined();
  });
});
