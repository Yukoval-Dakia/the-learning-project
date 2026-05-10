import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { FK_ORDER } from '../export/constants';
import { importRoute } from './import';

function mockEnv() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const batchCalls: Array<Array<{ sql: string; binds: unknown[] }>> = [];

  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...binds: unknown[]) => {
        const tagged = {
          __sql: sql,
          __binds: binds,
          run: async () => {
            calls.push({ sql, binds });
            return { success: true, meta: { changes: 1 } };
          },
        };
        return tagged;
      },
      run: async () => {
        calls.push({ sql, binds: [] });
        return { success: true, meta: { changes: 0 } };
      },
    })),
    batch: vi.fn(async (stmts: Array<{ __sql?: string; __binds?: unknown[] }>) => {
      const stmtCalls = stmts.map((s) => ({
        sql: s.__sql ?? '',
        binds: s.__binds ?? [],
      }));
      batchCalls.push(stmtCalls);
      return [{ success: true, meta: { changes: stmts.length } }];
    }),
  } as unknown as D1Database;

  const IMAGES = {
    put: vi.fn(async () => null),
  } as unknown as R2Bucket;

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

function buildZip(files: Record<string, string | Uint8Array>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) {
    entries[k] = typeof v === 'string' ? new TextEncoder().encode(v) : v;
  }
  return zipSync(entries);
}

describe('POST /api/_/import — guards', () => {
  it('returns 400 when ?confirm is missing', async () => {
    const { Bindings } = mockEnv();
    const res = await importRoute.request(
      '/',
      { method: 'POST', body: new Uint8Array() },
      Bindings,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('confirm_required');
  });

  it('returns 400 when ?confirm has wrong value', async () => {
    const { Bindings } = mockEnv();
    const res = await importRoute.request(
      '/?confirm=please',
      { method: 'POST', body: new Uint8Array() },
      Bindings,
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on empty body', async () => {
    const { Bindings } = mockEnv();
    const res = await importRoute.request(
      '/?confirm=wipe-and-reload',
      { method: 'POST', body: new Uint8Array(0) },
      Bindings,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });

  it('returns 400 on invalid ZIP', async () => {
    const { Bindings } = mockEnv();
    const garbage = new TextEncoder().encode('not a zip');
    const res = await importRoute.request(
      '/?confirm=wipe-and-reload',
      { method: 'POST', body: garbage },
      Bindings,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_zip');
  });

  it('returns 400 on schema_version mismatch', async () => {
    const { Bindings } = mockEnv();
    const zip = buildZip({
      'manifest.json': JSON.stringify({
        schema_version: '0.9',
        exported_at: 1700000000,
        include_assets: false,
        row_counts: {},
        asset_count: 0,
      }),
      'data.json': JSON.stringify({}),
    });
    const res = await importRoute.request(
      '/?confirm=wipe-and-reload',
      { method: 'POST', body: zip },
      Bindings,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; expected: string; got: string };
    expect(body.error).toBe('schema_version_mismatch');
    expect(body.expected).toBe('1.0');
    expect(body.got).toBe('0.9');
  });

  it('returns 400 when manifest.json is missing from ZIP', async () => {
    const { Bindings } = mockEnv();
    const zip = buildZip({ 'data.json': '{}' });
    const res = await importRoute.request(
      '/?confirm=wipe-and-reload',
      { method: 'POST', body: zip },
      Bindings,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('invalid_zip');
    expect(body.message).toContain('manifest.json');
  });
});

describe('POST /api/_/import — wipe + reinsert', () => {
  it('issues DELETE FROM in REVERSE FK order before any INSERT', async () => {
    const { Bindings, calls } = mockEnv();
    const zip = buildZip({
      'manifest.json': JSON.stringify({
        schema_version: '1.0',
        exported_at: 1700000000,
        include_assets: false,
        row_counts: {},
        asset_count: 0,
      }),
      'data.json': JSON.stringify({}),
    });
    await importRoute.request('/?confirm=wipe-and-reload', { method: 'POST', body: zip }, Bindings);
    const deletes = calls.filter((c) => /^delete from/i.test(c.sql));
    expect(deletes.length).toBe(FK_ORDER.length);
    expect(deletes[0].sql).toMatch(new RegExp(`delete from ${FK_ORDER[FK_ORDER.length - 1]}`, 'i'));
    expect(deletes[deletes.length - 1].sql).toMatch(new RegExp(`delete from ${FK_ORDER[0]}`, 'i'));
  });

  it('inserts data in FORWARD FK order via D1.batch', async () => {
    const { Bindings, batchCalls } = mockEnv();
    const zip = buildZip({
      'manifest.json': JSON.stringify({
        schema_version: '1.0',
        exported_at: 1700000000,
        include_assets: false,
        row_counts: { knowledge: 1, mistake: 1 },
        asset_count: 0,
      }),
      'data.json': JSON.stringify({
        knowledge: [{ id: 'k1', name: 'x', parent_id: null }],
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
      }),
    });
    await importRoute.request('/?confirm=wipe-and-reload', { method: 'POST', body: zip }, Bindings);
    expect(batchCalls.length).toBe(2);
    expect(batchCalls[0][0].sql).toMatch(/insert into knowledge/i);
    expect(batchCalls[1][0].sql).toMatch(/insert into mistake/i);
  });

  it('chunks large inserts into batches of INSERT_BATCH_SIZE', async () => {
    const { Bindings, batchCalls } = mockEnv();
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: `k${i}`,
      name: `n${i}`,
      parent_id: null,
    }));
    const zip = buildZip({
      'manifest.json': JSON.stringify({
        schema_version: '1.0',
        exported_at: 1700000000,
        include_assets: false,
        row_counts: { knowledge: 120 },
        asset_count: 0,
      }),
      'data.json': JSON.stringify({ knowledge: rows }),
    });
    await importRoute.request('/?confirm=wipe-and-reload', { method: 'POST', body: zip }, Bindings);
    expect(batchCalls.length).toBe(3);
    expect(batchCalls[0].length).toBe(50);
    expect(batchCalls[1].length).toBe(50);
    expect(batchCalls[2].length).toBe(20);
  });

  it('PUTs assets/<key> to R2 when assets are present', async () => {
    const { Bindings } = mockEnv();
    const zip = buildZip({
      'manifest.json': JSON.stringify({
        schema_version: '1.0',
        exported_at: 1700000000,
        include_assets: true,
        row_counts: {},
        asset_count: 2,
      }),
      'data.json': JSON.stringify({}),
      'assets/sk-1': 'IMG-A',
      'assets/sk-2': 'IMG-B',
    });
    await importRoute.request('/?confirm=wipe-and-reload', { method: 'POST', body: zip }, Bindings);
    expect(Bindings.IMAGES.put).toHaveBeenCalledTimes(2);
    expect((Bindings.IMAGES.put as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('sk-1');
    expect((Bindings.IMAGES.put as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe('sk-2');
  });

  it('returns ok:true with stats per table', async () => {
    const { Bindings } = mockEnv();
    const zip = buildZip({
      'manifest.json': JSON.stringify({
        schema_version: '1.0',
        exported_at: 1700000000,
        include_assets: false,
        row_counts: { knowledge: 1 },
        asset_count: 0,
      }),
      'data.json': JSON.stringify({
        knowledge: [{ id: 'k1', name: 'x', parent_id: null }],
      }),
    });
    const res = await importRoute.request(
      '/?confirm=wipe-and-reload',
      { method: 'POST', body: zip },
      Bindings,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      stats: Record<string, { deleted: number; inserted: number }>;
      assets_uploaded: number;
    };
    expect(body.ok).toBe(true);
    expect(body.stats.knowledge.inserted).toBe(1);
  });
});

describe('POST /api/_/import — R2 failure surfacing', () => {
  it('returns ok:false + failed_keys when an R2 PUT throws', async () => {
    const { Bindings } = mockEnv();
    // Override IMAGES.put to throw for sk-2 only.
    Bindings.IMAGES = {
      put: vi.fn(async (key: string) => {
        if (key === 'sk-2') throw new Error('R2 unavailable');
        return null;
      }),
    } as unknown as R2Bucket;
    const zip = buildZip({
      'manifest.json': JSON.stringify({
        schema_version: '1.0',
        exported_at: 1700000000,
        include_assets: true,
        row_counts: {},
        asset_count: 2,
      }),
      'data.json': JSON.stringify({}),
      'assets/sk-1': 'IMG-A',
      'assets/sk-2': 'IMG-B',
    });
    const res = await importRoute.request(
      '/?confirm=wipe-and-reload',
      { method: 'POST', body: zip },
      Bindings,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      assets_uploaded: number;
      assets_failed: number;
      failed_keys: string[];
    };
    expect(body.ok).toBe(false);
    expect(body.assets_uploaded).toBe(1);
    expect(body.assets_failed).toBe(1);
    expect(body.failed_keys).toEqual(['sk-2']);
  });
});

describe('POST /api/_/import — pre-flight validation', () => {
  it('rejects data.json with column shape mismatch BEFORE wiping D1', async () => {
    const { Bindings, calls } = mockEnv();
    const zip = buildZip({
      'manifest.json': JSON.stringify({
        schema_version: '1.0',
        exported_at: 1700000000,
        include_assets: false,
        row_counts: { knowledge: 2 },
        asset_count: 0,
      }),
      'data.json': JSON.stringify({
        knowledge: [
          { id: 'k1', name: 'x', parent_id: null },
          { id: 'k2', name: 'y' }, // missing parent_id!
        ],
      }),
    });
    const res = await importRoute.request(
      '/?confirm=wipe-and-reload',
      { method: 'POST', body: zip },
      Bindings,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe('data_validation_failed');
    expect(body.issues.length).toBeGreaterThan(0);
    // CRITICAL: no DELETE issued — D1 NOT touched.
    expect(calls.filter((c) => /^delete from/i.test(c.sql)).length).toBe(0);
  });
});
