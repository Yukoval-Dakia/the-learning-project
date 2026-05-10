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
