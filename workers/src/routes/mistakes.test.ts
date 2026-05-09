import { describe, expect, it, vi } from 'vitest';
import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';
import { mistakes } from './mistakes';

function mockEnv(opts: {
  knowledgeRows?: Array<{ id: string; name: string; domain: string | null; parent_id: string | null; archived_at: number | null }>;
} = {}) {
  const knowledgeById = new Map((opts.knowledgeRows ?? []).map((r) => [r.id, r]));
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...binds: unknown[]) => {
      calls.push({ sql, binds });
      return {
        first: async () => {
          if (/select id from knowledge where id = \?/i.test(sql)) {
            const id = binds[0] as string;
            const row = knowledgeById.get(id);
            return row && row.archived_at === null ? { id } : null;
          }
          return null;
        },
        all: async () => {
          if (/from knowledge/i.test(sql)) return { results: Array.from(knowledgeById.values()) };
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
  const waitUntilFns: Array<Promise<unknown>> = [];
  const executionCtx = {
    waitUntil: (p: Promise<unknown>) => {
      waitUntilFns.push(p);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  return {
    Bindings: { DB: db, INTERNAL_TOKEN: 'test', ANTHROPIC_API_KEY: 'test' },
    executionCtx,
    calls,
    waitUntilFns,
  };
}

describe('POST /api/mistakes', () => {
  it('returns 400 when prompt_md is empty', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: '',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: ['k1'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 when knowledge_ids contains non-existent id', async () => {
    const { Bindings, executionCtx } = mockEnv({
      knowledgeRows: [{ id: 'k_real', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    const res = await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: ['k_real', 'k_missing'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/k_missing/);
  });

  it('inserts question + mistake on valid body, queues propose task', async () => {
    const { Bindings, executionCtx, calls, waitUntilFns } = mockEnv({
      knowledgeRows: [{ id: 'k_xuci', name: '虚词', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    const res = await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: '"之"在主谓间的用法?',
          reference_md: '取消句子独立性',
          wrong_answer_md: '助词',
          knowledge_ids: ['k_xuci'],
          cause: { primary_category: 'concept', user_notes: '没记牢' },
          difficulty: 3,
          question_kind: 'short_answer',
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { question_id: string; mistake_id: string; propose_task: string };
    expect(body.question_id).toBeTruthy();
    expect(body.mistake_id).toBeTruthy();
    expect(body.propose_task).toBe('queued');
    expect(calls.some((c) => /insert into question/i.test(c.sql))).toBe(true);
    expect(calls.some((c) => /insert into mistake/i.test(c.sql))).toBe(true);
    expect(waitUntilFns).toHaveLength(1);
  });

  it('rejects empty knowledge_ids array', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: [],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
  });

  it('persists null cause when not provided', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({
      knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    const res = await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: ['k1'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(200);
    const insertMistakeCall = calls.find((c) => /insert into mistake/i.test(c.sql));
    expect(insertMistakeCall).toBeDefined();
    expect(insertMistakeCall?.binds[4]).toBeNull();
  });

  it('rejects when total image bytes exceed D1 cell limit', async () => {
    const { Bindings, executionCtx } = mockEnv({
      knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    const big = 'x'.repeat(900_000);
    const res = await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: ['k1'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
          prompt_image_refs: [big],
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toMatch(/prompt_image_refs/);
  });

  it('rejects when wrong_answer_image_refs total exceeds limit', async () => {
    const { Bindings, executionCtx } = mockEnv({
      knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    const half = 'y'.repeat(500_000);
    const res = await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: ['k1'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
          wrong_answer_image_refs: [half, half],
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.message).toMatch(/wrong_answer_image_refs/);
  });

  it('persists prompt_image_refs in question.metadata and wrong_answer_image_refs', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({
      knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    const promptImage = 'data:image/png;base64,iVBORw0KGgoAAAA';
    const wrongImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEA';
    const res = await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: ['k1'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
          prompt_image_refs: [promptImage],
          wrong_answer_image_refs: [wrongImage],
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(res.status).toBe(200);
    const insertQuestionCall = calls.find((c) => /insert into question/i.test(c.sql));
    const insertMistakeCall = calls.find((c) => /insert into mistake/i.test(c.sql));
    const questionMetadataBind = insertQuestionCall?.binds[6] as string | null;
    expect(questionMetadataBind).not.toBeNull();
    expect(JSON.parse(questionMetadataBind ?? '{}')).toEqual({ prompt_image_refs: [promptImage] });
    const mistakeImageRefsBind = insertMistakeCall?.binds[5] as string;
    expect(JSON.parse(mistakeImageRefsBind)).toEqual([wrongImage]);
  });

  it('queues both propose + attribution when cause is null', async () => {
    const { Bindings, executionCtx, waitUntilFns } = mockEnv({
      knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: ['k1'],
          cause: null,
          difficulty: 3,
          question_kind: 'short_answer',
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(waitUntilFns).toHaveLength(2);
  });

  it('queues only propose when cause is provided manually', async () => {
    const { Bindings, executionCtx, waitUntilFns } = mockEnv({
      knowledgeRows: [{ id: 'k1', name: 'X', domain: 'wenyan', parent_id: null, archived_at: null }],
    });
    await mistakes.request(
      '/',
      {
        method: 'POST',
        body: JSON.stringify({
          prompt_md: 'p',
          reference_md: null,
          wrong_answer_md: 'w',
          knowledge_ids: ['k1'],
          cause: { primary_category: 'concept', user_notes: null },
          difficulty: 3,
          question_kind: 'short_answer',
        }),
        headers: { 'content-type': 'application/json' },
      },
      Bindings,
      executionCtx,
    );
    expect(waitUntilFns).toHaveLength(1);
  });
});
