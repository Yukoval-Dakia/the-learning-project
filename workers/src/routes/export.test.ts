import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import { unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { exportRoute } from './export';

function mockEnv(opts: { tables?: Record<string, unknown[]> } = {}) {
  const tables = opts.tables ?? {};
  // The export route uses `prepare(sql).all()` directly (no `.bind()`).
  // Some Hono/D1 patterns chain through bind regardless. Support both shapes.
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

  const IMAGES = {
    get: vi.fn(async () => null),
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
  };
}

describe('GET /api/_/export — refs only', () => {
  it('returns 200 application/zip with content-disposition', async () => {
    const { Bindings } = mockEnv({
      tables: {
        knowledge: [{ id: 'k1', name: '虚词', parent_id: null }],
        mistake: [],
      },
    });
    const res = await exportRoute.request('/', { method: 'GET' }, Bindings);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(
      /attachment; filename="loom-backup-\d{4}-\d{2}-\d{2}\.zip"/,
    );
  });

  it('ZIP contains manifest.json + data.json + 2 csv + README.md', async () => {
    const { Bindings } = mockEnv({
      tables: { knowledge: [{ id: 'k1', name: 'x', parent_id: null }] },
    });
    const res = await exportRoute.request('/', { method: 'GET' }, Bindings);
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(Object.keys(entries).sort()).toEqual([
      'README.md',
      'data.json',
      'manifest.json',
      'mistakes.csv',
      'review_events.csv',
    ]);
  });

  it('manifest.json has correct schema_version and row_counts', async () => {
    const { Bindings } = mockEnv({
      tables: {
        knowledge: [
          { id: 'k1', name: 'x', parent_id: null },
          { id: 'k2', name: 'y', parent_id: null },
        ],
        mistake: [{ id: 'm1', question_id: 'q1', knowledge_ids: '[]' }],
      },
    });
    const res = await exportRoute.request('/', { method: 'GET' }, Bindings);
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    expect(manifest.schema_version).toBe('1.0');
    expect(manifest.include_assets).toBe(false);
    expect(manifest.row_counts.knowledge).toBe(2);
    expect(manifest.row_counts.mistake).toBe(1);
    expect(manifest.asset_count).toBe(0);
  });

  it('does NOT call IMAGES.get when include_assets is absent', async () => {
    const { Bindings } = mockEnv({
      tables: { source_asset: [{ id: 'a1', storage_key: 'sk1' }] },
    });
    await exportRoute.request('/', { method: 'GET' }, Bindings);
    expect(Bindings.IMAGES.get).not.toHaveBeenCalled();
  });
});

describe('GET /api/_/export?include_assets=1', () => {
  function r2WithBytes(map: Record<string, string>) {
    return {
      get: vi.fn(async (key: string) => {
        if (!(key in map)) return null;
        const bytes = new TextEncoder().encode(map[key]);
        return {
          body: new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(bytes);
              ctrl.close();
            },
          }),
        };
      }),
    } as unknown as R2Bucket;
  }

  it('includes assets/ entries with R2 bytes', async () => {
    const { Bindings } = mockEnv({
      tables: {
        source_asset: [
          { id: 'a1', storage_key: 'sk-1' },
          { id: 'a2', storage_key: 'sk-2' },
        ],
      },
    });
    Bindings.IMAGES = r2WithBytes({ 'sk-1': 'PNG-A', 'sk-2': 'PNG-B' });
    const res = await exportRoute.request('/?include_assets=1', { method: 'GET' }, Bindings);
    expect(res.status).toBe(200);
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(entries['assets/sk-1']).toBeDefined();
    expect(entries['assets/sk-2']).toBeDefined();
    expect(new TextDecoder().decode(entries['assets/sk-1'])).toBe('PNG-A');
  });

  it('skips assets whose R2 object is missing AND records key in manifest.missing_assets', async () => {
    const { Bindings } = mockEnv({
      tables: {
        source_asset: [
          { id: 'a1', storage_key: 'sk-present' },
          { id: 'a2', storage_key: 'sk-missing' },
        ],
      },
    });
    Bindings.IMAGES = r2WithBytes({ 'sk-present': 'X' });
    const res = await exportRoute.request('/?include_assets=1', { method: 'GET' }, Bindings);
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    expect(entries['assets/sk-present']).toBeDefined();
    expect(entries['assets/sk-missing']).toBeUndefined();
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    expect(manifest.missing_assets).toContain('sk-missing');
    expect(manifest.asset_count).toBe(1); // present minus missing
  });

  it('manifest reports include_assets:true and asset_count', async () => {
    const { Bindings } = mockEnv({
      tables: { source_asset: [{ id: 'a1', storage_key: 'sk-1' }] },
    });
    Bindings.IMAGES = r2WithBytes({ 'sk-1': 'X' });
    const res = await exportRoute.request('/?include_assets=1', { method: 'GET' }, Bindings);
    const ab = await res.arrayBuffer();
    const entries = unzipSync(new Uint8Array(ab));
    const manifest = JSON.parse(new TextDecoder().decode(entries['manifest.json']));
    expect(manifest.include_assets).toBe(true);
    expect(manifest.asset_count).toBe(1);
  });

  it('returns 400 too_many_assets when source_asset > MAX_INLINE_ASSETS', async () => {
    const assets = Array.from({ length: 46 }, (_, i) => ({
      id: `a${i}`,
      storage_key: `sk-${i}`,
    }));
    const { Bindings } = mockEnv({ tables: { source_asset: assets } });
    Bindings.IMAGES = r2WithBytes({});
    const res = await exportRoute.request('/?include_assets=1', { method: 'GET' }, Bindings);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; count: number; limit: number };
    expect(body.error).toBe('too_many_assets');
    expect(body.count).toBe(46);
    expect(body.limit).toBe(45);
    expect(Bindings.IMAGES.get).not.toHaveBeenCalled();
  });
});
