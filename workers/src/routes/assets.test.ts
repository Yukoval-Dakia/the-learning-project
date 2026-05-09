import { describe, expect, it, vi } from 'vitest';
import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import { assets } from './assets';

function mockEnv() {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const put = vi.fn(async () => null);
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...binds: unknown[]) => {
        calls.push({ sql, binds });
        return { run: async () => ({ success: true, meta: { changes: 1 } }) };
      },
    })),
  } as unknown as D1Database;
  return {
    Bindings: {
      DB: db,
      IMAGES: { put } as unknown as R2Bucket,
      INTERNAL_TOKEN: 't',
      ANTHROPIC_API_KEY: 't',
    },
    executionCtx: {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
    calls,
    put,
  };
}

describe('POST /api/assets', () => {
  it('uploads PNG and writes source_asset metadata', async () => {
    const { Bindings, executionCtx, calls, put } = mockEnv();
    const form = new FormData();
    form.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'q.png', { type: 'image/png' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { asset: { id: string; storage_key: string; mime_type: string; sha256: string } };
    expect(body.asset.id).toBeTruthy();
    expect(body.asset.storage_key).toMatch(/^images\/[a-z0-9]+\.png$/);
    expect(body.asset.mime_type).toBe('image/png');
    expect(body.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(put).toHaveBeenCalledOnce();
    expect(calls.some((c) => /insert into source_asset/i.test(c.sql))).toBe(true);
  });

  it('rejects missing file', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await assets.request('/', { method: 'POST', body: new FormData() }, Bindings, executionCtx);
    expect(res.status).toBe(400);
  });

  it('rejects non-image mime', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const form = new FormData();
    form.set('file', new File(['x'], 'note.txt', { type: 'text/plain' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/unsupported mime_type/);
  });

  it('rejects oversized file', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const big = new Uint8Array(9_000_000);
    const form = new FormData();
    form.set('file', new File([big], 'huge.png', { type: 'image/png' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(400);
  });
});
