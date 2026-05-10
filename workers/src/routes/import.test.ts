import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
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
    batch: vi.fn(
      async (stmts: Array<{ __sql?: string; __binds?: unknown[] }>) => {
        const stmtCalls = stmts.map((s) => ({
          sql: s.__sql ?? '',
          binds: s.__binds ?? [],
        }));
        batchCalls.push(stmtCalls);
        return [{ success: true, meta: { changes: stmts.length } }];
      },
    ),
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
