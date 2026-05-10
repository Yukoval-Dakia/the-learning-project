import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { exportRoute } from './export';
import { importRoute } from './import';

function exportEnv(tables: Record<string, unknown[]>) {
  const buildBoundOrUnbound = (sql: string) => ({
    first: async () => null,
    run: async () => ({ success: true, meta: { changes: 0 } }),
    all: async () => {
      const m = sql.match(/from (\w+)/i);
      const t = m?.[1] ?? '';
      return { results: tables[t] ?? [] };
    },
  });
  const db = {
    prepare: vi.fn((sql: string) => ({
      ...buildBoundOrUnbound(sql),
      bind: () => buildBoundOrUnbound(sql),
    })),
  } as unknown as D1Database;
  const IMAGES = { get: vi.fn(async () => null) } as unknown as R2Bucket;
  return {
    DB: db,
    IMAGES,
    INTERNAL_TOKEN: 'test',
    ANTHROPIC_API_KEY: 'test',
    TENCENT_SECRET_ID: 'test',
    TENCENT_SECRET_KEY: 'test',
    TENCENT_OCR_REGION: 'ap-guangzhou',
  };
}

function importEnv() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const batchCalls: Array<Array<{ sql: string; binds: unknown[] }>> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...binds: unknown[]) => ({
        __sql: sql,
        __binds: binds,
        run: async () => {
          calls.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
        },
      }),
      run: async () => {
        calls.push({ sql, binds: [] });
        return { success: true, meta: { changes: 0 } };
      },
    })),
    batch: vi.fn(async (stmts: Array<{ __sql?: string; __binds?: unknown[] }>) => {
      batchCalls.push(stmts.map((s) => ({ sql: s.__sql ?? '', binds: s.__binds ?? [] })));
      return [{ success: true, meta: { changes: stmts.length } }];
    }),
  } as unknown as D1Database;
  const IMAGES = { put: vi.fn(async () => null) } as unknown as R2Bucket;
  return {
    Bindings: {
      DB: db,
      IMAGES,
      INTERNAL_TOKEN: 'test',
      ANTHROPIC_API_KEY: 'test',
      TENCENT_SECRET_ID: 'test',
      TENCENT_SECRET_KEY: 'test',
      TENCENT_OCR_REGION: 'ap-guangzhou',
    },
    calls,
    batchCalls,
  };
}

describe('round-trip: export → import → DB state mirrored', () => {
  it('preserves rows from one knowledge + one mistake fixture', async () => {
    const fixture = {
      knowledge: [
        { id: 'k1', name: '虚词', parent_id: null, archived_at: null, effective_domain: 'wenyan' },
      ],
      mistake: [
        {
          id: 'm1',
          question_id: 'q1',
          wrong_answer_md: 'oops',
          knowledge_ids: '["k1"]',
          cause: null,
          wrong_answer_image_refs: '[]',
          source: 'manual',
          variants: '[]',
          variants_generated_count: 0,
          variants_max: 3,
          status: 'active',
          fsrs_state: null,
          created_at: 1700000000,
          updated_at: 1700000000,
          version: 0,
        },
      ],
    };

    // 1. Export
    const exportRes = await exportRoute.request(
      '/',
      { method: 'GET' },
      exportEnv(fixture),
    );
    expect(exportRes.status).toBe(200);
    const ab = await exportRes.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(entries['data.json']).toBeDefined();
    expect(entries['manifest.json']).toBeDefined();

    // 2. Import the same ZIP into a fresh import env
    const { Bindings, batchCalls } = importEnv();
    const zipBytes = new Uint8Array(ab);
    const importRes = await importRoute.request(
      '/?confirm=wipe-and-reload',
      { method: 'POST', body: zipBytes },
      Bindings,
    );
    expect(importRes.status).toBe(200);
    const body = (await importRes.json()) as {
      ok: boolean;
      stats: Record<string, { inserted: number }>;
    };

    // 3. Assert: knowledge inserted, mistake inserted, others empty
    expect(body.ok).toBe(true);
    expect(body.stats.knowledge.inserted).toBe(1);
    expect(body.stats.mistake.inserted).toBe(1);
    expect(body.stats.review_event.inserted).toBe(0);

    // 4. The actual binds for knowledge match fixture
    const knowledgeBatch = batchCalls.find((b) => /insert into knowledge/i.test(b[0]?.sql ?? ''));
    expect(knowledgeBatch).toBeDefined();
    expect(knowledgeBatch![0].binds).toContain('k1');
    expect(knowledgeBatch![0].binds).toContain('虚词');
  });
});
