import { describe, expect, it, vi } from 'vitest';
import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import { review } from './review';

type DueRow = {
  id: string;
  question_id: string;
  knowledge_ids: string;
  cause: string | null;
  fsrs_state: string | null;
  created_at: number;
  prompt_md: string;
  reference_md: string | null;
};

function mockEnv(opts: {
  dueRows?: DueRow[];
} = {}) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => null,
        all: async () => {
          if (/from mistake m\s+join question q/i.test(sql)) {
            return { results: opts.dueRows ?? [] };
          }
          return { results: [] };
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
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
  };
}

describe('GET /api/review/due', () => {
  it('returns never-reviewed mistakes first (null fsrs_state) and emits the SQL ordering clause', async () => {
    const dueRows: DueRow[] = [
      {
        id: 'm_null',
        question_id: 'q1',
        knowledge_ids: '["k1"]',
        cause: null,
        fsrs_state: null,
        created_at: 1700000000,
        prompt_md: 'P null',
        reference_md: null,
      },
      {
        id: 'm_due',
        question_id: 'q2',
        knowledge_ids: '["k1"]',
        cause: '{"primary_category":"concept","secondary_categories":[],"ai_analysis_md":"a","user_edited":false}',
        fsrs_state:
          '{"due":"2026-05-09T12:00:00.000Z","stability":1.5,"difficulty":5,"elapsed_days":0,"scheduled_days":1,"learning_steps":0,"reps":1,"lapses":0,"state":"review","last_review":"2026-05-08T12:00:00.000Z"}',
        created_at: 1700000010,
        prompt_md: 'P due',
        reference_md: 'R due',
      },
    ];
    const { Bindings, executionCtx, calls } = mockEnv({ dueRows });
    const res = await review.request('/due', { method: 'GET' }, Bindings, executionCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string; fsrs_state: unknown }> };
    expect(body.rows).toHaveLength(2);
    expect(body.rows[0].id).toBe('m_null');
    expect(body.rows[0].fsrs_state).toBeNull();
    expect(body.rows[1].id).toBe('m_due');
    const sql = calls[0]?.sql ?? '';
    expect(sql).toMatch(/\(m\.fsrs_state is null\) desc/i);
  });

  it('SQL filters by fsrs_state null OR json_extract due <= now', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ dueRows: [] });
    await review.request('/due', { method: 'GET' }, Bindings, executionCtx);
    const sql = calls[0]?.sql ?? '';
    expect(sql).toMatch(/m\.fsrs_state is null/i);
    expect(sql).toMatch(/json_extract\(m\.fsrs_state, '\$\.due'\) <=\s*\?/i);
  });

  it('respects ?limit=3 → bind contains 3', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ dueRows: [] });
    await review.request('/due?limit=3', { method: 'GET' }, Bindings, executionCtx);
    expect(calls[0]?.binds).toContain(3);
  });

  it('clamps limit edge cases: 999→50, 0→1, abc→20', async () => {
    {
      const { Bindings, executionCtx, calls } = mockEnv({ dueRows: [] });
      await review.request('/due?limit=999', { method: 'GET' }, Bindings, executionCtx);
      expect(calls[0]?.binds).toContain(50);
    }
    {
      const { Bindings, executionCtx, calls } = mockEnv({ dueRows: [] });
      await review.request('/due?limit=0', { method: 'GET' }, Bindings, executionCtx);
      expect(calls[0]?.binds).toContain(1);
    }
    {
      const { Bindings, executionCtx, calls } = mockEnv({ dueRows: [] });
      await review.request('/due?limit=abc', { method: 'GET' }, Bindings, executionCtx);
      expect(calls[0]?.binds).toContain(20);
    }
  });

  it('SQL filters archived + deleted + active status', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ dueRows: [] });
    await review.request('/due', { method: 'GET' }, Bindings, executionCtx);
    const sql = calls[0]?.sql ?? '';
    expect(sql).toMatch(/m\.archived_at is null/i);
    expect(sql).toMatch(/m\.deleted_at is null/i);
    expect(sql).toMatch(/m\.status = 'active'/i);
  });

  it('truncates prompt_md / reference_md to 1000 chars', async () => {
    const long = 'X'.repeat(1500);
    const dueRows: DueRow[] = [
      {
        id: 'm1',
        question_id: 'q1',
        knowledge_ids: '["k1"]',
        cause: null,
        fsrs_state: null,
        created_at: 1700000000,
        prompt_md: long,
        reference_md: long,
      },
    ];
    const { Bindings, executionCtx } = mockEnv({ dueRows });
    const res = await review.request('/due', { method: 'GET' }, Bindings, executionCtx);
    const body = (await res.json()) as { rows: Array<{ prompt_md: string; reference_md: string }> };
    expect(body.rows[0].prompt_md).toHaveLength(1000);
    expect(body.rows[0].reference_md).toHaveLength(1000);
  });
});
