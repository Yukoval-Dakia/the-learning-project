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

type MistakeRow = {
  id: string;
  fsrs_state: string | null;
  version: number;
  archived_at: number | null;
  deleted_at: number | null;
};

type BatchResult = Array<{ meta?: { changes?: number } }>;

type BatchCall = {
  stmts: Array<{ sql: string; binds: unknown[] }>;
};

function mockEnv(opts: {
  dueRows?: DueRow[];
  mistakeById?: Map<string, MistakeRow>;
  batchResult?: BatchResult;
} = {}) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const batchCalls: BatchCall[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      const wrapped = {
        __sql: sql,
        __binds: binds,
        first: async () => {
          if (/select id, fsrs_state, version, archived_at, deleted_at from mistake where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            return opts.mistakeById?.get(id) ?? null;
          }
          return null;
        },
        all: async () => {
          if (/from mistake m\s+join question q/i.test(sql)) {
            return { results: opts.dueRows ?? [] };
          }
          return { results: [] };
        },
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
      return wrapped;
    },
  }));
  const db = {
    prepare,
    batch: async (stmts: Array<{ __sql: string; __binds: unknown[] }>) => {
      batchCalls.push({
        stmts: stmts.map((s) => ({ sql: s.__sql, binds: s.__binds })),
      });
      return opts.batchResult ?? [{ meta: { changes: 1 } }, { meta: { changes: 1 } }];
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

  it('skips rows with corrupt JSON; remaining rows still returned', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dueRows: DueRow[] = [
      {
        id: 'm_corrupt',
        question_id: 'q1',
        knowledge_ids: '{not valid', // poison
        cause: null,
        fsrs_state: null,
        created_at: 1700000000,
        prompt_md: 'p',
        reference_md: null,
      },
      {
        id: 'm_ok',
        question_id: 'q2',
        knowledge_ids: '["k1"]',
        cause: null,
        fsrs_state: null,
        created_at: 1700000001,
        prompt_md: 'p2',
        reference_md: null,
      },
    ];
    const { Bindings, executionCtx } = mockEnv({ dueRows });
    const res = await review.request('/due', { method: 'GET' }, Bindings, executionCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: Array<{ id: string }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe('m_ok');
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
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

function submitReq(body: unknown) {
  return {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  };
}

describe('POST /api/review/submit', () => {
  it('first review (fsrs_state was null) → batch atomic UPDATE+INSERT, returns next state', async () => {
    const mistakeById = new Map<string, MistakeRow>([
      ['m1', { id: 'm1', fsrs_state: null, version: 0, archived_at: null, deleted_at: null }],
    ]);
    const { Bindings, executionCtx, batchCalls } = mockEnv({ mistakeById });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm1', rating: 'good', latency_ms: 5000 }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      next_due_at: number;
      new_state: { reps: number; scheduled_days: number };
    };
    expect(typeof body.next_due_at).toBe('number');
    expect(body.next_due_at).toBeGreaterThan(0);
    expect(body.new_state.reps).toBeGreaterThanOrEqual(1);

    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].stmts).toHaveLength(2);

    const updateStmt = batchCalls[0].stmts[0];
    expect(updateStmt.sql).toMatch(/update mistake set fsrs_state =/i);
    expect(updateStmt.binds).toContain('m1');
    expect(updateStmt.binds).toContain(0); // old version

    const insertStmt = batchCalls[0].stmts[1];
    expect(insertStmt.sql).toMatch(/insert into review_event/i);
    // binds order: id, mistake_id, rating, response_md, latency_ms, before, after, due_before, due_next, created_at
    expect(insertStmt.binds[1]).toBe('m1');
    expect(insertStmt.binds[2]).toBe('good');
    expect(insertStmt.binds[3]).toBeNull(); // response_md
    expect(insertStmt.binds[4]).toBe(5000); // latency_ms
    expect(insertStmt.binds[5]).toBeNull(); // fsrs_state_before
    expect(typeof insertStmt.binds[6]).toBe('string'); // fsrs_state_after JSON
    expect(insertStmt.binds[7]).toBeNull(); // due_at_before
    expect(typeof insertStmt.binds[8]).toBe('number'); // due_at_next unix seconds
  });

  it('second review (DB-shaped JSON with ISO strings) survives Plan F1 — coerces strings to Date before ts-fsrs', async () => {
    const dueIso = '2026-05-09T12:00:00.000Z';
    const lastReviewIso = '2026-05-08T12:00:00.000Z';
    const mistakeById = new Map<string, MistakeRow>([
      [
        'm1',
        {
          id: 'm1',
          fsrs_state: JSON.stringify({
            due: dueIso,
            stability: 1.5,
            difficulty: 5,
            elapsed_days: 0,
            scheduled_days: 1,
            learning_steps: 0,
            reps: 1,
            lapses: 0,
            state: 'review',
            last_review: lastReviewIso,
          }),
          version: 1,
          archived_at: null,
          deleted_at: null,
        },
      ],
    ]);
    const { Bindings, executionCtx, batchCalls } = mockEnv({ mistakeById });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm1', rating: 'again' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      next_due_at: number;
      new_state: { scheduled_days: number; stability: number; lapses: number };
    };
    expect(Number.isFinite(body.next_due_at)).toBe(true);
    expect(body.next_due_at).toBeGreaterThan(0);
    expect(Number.isFinite(body.new_state.scheduled_days)).toBe(true);
    expect(Number.isFinite(body.new_state.stability)).toBe(true);

    // version=1 used in optimistic update
    const updateStmt = batchCalls[0].stmts[0];
    expect(updateStmt.binds).toContain(1);

    // due_at_before bind on the INSERT must be a finite unix timestamp derived from
    // the parsed prevState.due — would be NaN/string if FsrsState.parse() were skipped.
    const insertStmt = batchCalls[0].stmts[1];
    const expectedDueBefore = Math.floor(Date.parse(dueIso) / 1000);
    expect(insertStmt.binds).toContain(expectedDueBefore);
  });

  it('returns 422 corrupt_state when fsrs_state JSON is malformed', async () => {
    const mistakeById = new Map<string, MistakeRow>([
      [
        'm1',
        { id: 'm1', fsrs_state: '{not valid json', version: 0, archived_at: null, deleted_at: null },
      ],
    ]);
    const { Bindings, executionCtx, batchCalls } = mockEnv({ mistakeById });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm1', rating: 'good' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('corrupt_state');
    expect(body.message).toMatch(/m1/);
    expect(batchCalls).toHaveLength(0);
  });

  it('returns 422 corrupt_state when fsrs_state schema does not match (e.g. missing required field)', async () => {
    const mistakeById = new Map<string, MistakeRow>([
      [
        'm1',
        {
          id: 'm1',
          // valid JSON but missing required fields like 'state'
          fsrs_state: JSON.stringify({ due: '2026-05-10T00:00:00.000Z', stability: 1 }),
          version: 0,
          archived_at: null,
          deleted_at: null,
        },
      ],
    ]);
    const { Bindings, executionCtx, batchCalls } = mockEnv({ mistakeById });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm1', rating: 'good' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(422);
    expect(batchCalls).toHaveLength(0);
  });

  it('404 when mistake not found, batch NOT called', async () => {
    const { Bindings, executionCtx, batchCalls } = mockEnv({ mistakeById: new Map() });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm_missing', rating: 'good' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(404);
    expect(batchCalls).toHaveLength(0);
  });

  it('404 when mistake archived, batch NOT called', async () => {
    const mistakeById = new Map<string, MistakeRow>([
      ['m1', { id: 'm1', fsrs_state: null, version: 0, archived_at: 1700000000, deleted_at: null }],
    ]);
    const { Bindings, executionCtx, batchCalls } = mockEnv({ mistakeById });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm1', rating: 'good' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(404);
    expect(batchCalls).toHaveLength(0);
  });

  it('409 when version mismatch — review_event INSERT still committed (audit-only orphan, spec § 六)', async () => {
    const mistakeById = new Map<string, MistakeRow>([
      ['m1', { id: 'm1', fsrs_state: null, version: 5, archived_at: null, deleted_at: null }],
    ]);
    const { Bindings, executionCtx, batchCalls } = mockEnv({
      mistakeById,
      batchResult: [{ meta: { changes: 0 } }, { meta: { changes: 1 } }],
    });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm1', rating: 'good' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('conflict');
    // Crucial: the batch (containing both UPDATE + INSERT) was committed exactly once.
    expect(batchCalls).toHaveLength(1);
    expect(batchCalls[0].stmts).toHaveLength(2);
    expect(batchCalls[0].stmts[1].sql).toMatch(/insert into review_event/i);
  });

  it('400 when rating is not in enum (e.g. "easy")', async () => {
    const mistakeById = new Map<string, MistakeRow>([
      ['m1', { id: 'm1', fsrs_state: null, version: 0, archived_at: null, deleted_at: null }],
    ]);
    const { Bindings, executionCtx, batchCalls } = mockEnv({ mistakeById });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm1', rating: 'easy' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
    expect(batchCalls).toHaveLength(0);
  });

  it('400 when mistake_id is missing', async () => {
    const { Bindings, executionCtx, batchCalls } = mockEnv();
    const res = await review.request(
      '/submit',
      submitReq({ rating: 'good' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
    expect(batchCalls).toHaveLength(0);
  });

  it('binds null for response_md and latency_ms when not provided', async () => {
    const mistakeById = new Map<string, MistakeRow>([
      ['m1', { id: 'm1', fsrs_state: null, version: 0, archived_at: null, deleted_at: null }],
    ]);
    const { Bindings, executionCtx, batchCalls } = mockEnv({ mistakeById });
    const res = await review.request(
      '/submit',
      submitReq({ mistake_id: 'm1', rating: 'good' }),
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(200);
    const insertStmt = batchCalls[0].stmts[1];
    expect(insertStmt.binds[3]).toBeNull(); // response_md
    expect(insertStmt.binds[4]).toBeNull(); // latency_ms
  });
});
