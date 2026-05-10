import type { D1Database, ExecutionContext, R2Bucket } from '@cloudflare/workers-types';
import { describe, expect, it, vi } from 'vitest';
import { assets } from './assets';

function mockEnv(opts: { putThrows?: boolean; insertThrows?: boolean } = {}) {
  const calls: Array<{ sql: string; binds: unknown[] }> = [];
  const put = vi.fn<
    (
      key: string,
      bytes: ArrayBuffer,
      options?: { customMetadata?: { sha256?: string } },
    ) => Promise<null>
  >(async () => {
    if (opts.putThrows) throw new Error('R2 put failed');
    return null;
  });
  const del = vi.fn<(key: string) => Promise<void>>(async () => undefined);
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...binds: unknown[]) => {
        calls.push({ sql, binds });
        return {
          run: async () => {
            if (opts.insertThrows && /insert into source_asset/i.test(sql)) {
              throw new Error('D1 insert failed');
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    })),
  } as unknown as D1Database;
  return {
    Bindings: {
      DB: db,
      IMAGES: { put, delete: del } as unknown as R2Bucket,
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
    del,
  };
}

describe('POST /api/assets', () => {
  it('uploads PNG and writes source_asset metadata', async () => {
    const { Bindings, executionCtx, calls, put } = mockEnv();
    const form = new FormData();
    form.set(
      'file',
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'q.png', { type: 'image/png' }),
    );
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      asset: { id: string; storage_key: string; mime_type: string; sha256: string };
    };
    expect(body.asset.id).toBeTruthy();
    expect(body.asset.storage_key).toMatch(/^images\/[a-z0-9]+\.png$/);
    expect(body.asset.mime_type).toBe('image/png');
    expect(body.asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(put).toHaveBeenCalledOnce();
    expect(calls.some((c) => /insert into source_asset/i.test(c.sql))).toBe(true);
    // sha256 must match between R2 customMetadata and D1 row (same source).
    const putOpts = put.mock.calls[0][2] as { customMetadata?: { sha256?: string } } | undefined;
    // biome-ignore lint/style/noNonNullAssertion: test code, guaranteed by test setup
    const insertCall = calls.find((c) => /insert into source_asset/i.test(c.sql))!;
    expect(putOpts?.customMetadata?.sha256).toBe(body.asset.sha256);
    expect(insertCall.binds[4]).toBe(body.asset.sha256);
  });

  it('rolls back R2 object when D1 insert fails', async () => {
    const { Bindings, executionCtx, put, del } = mockEnv({ insertThrows: true });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'q.png', { type: 'image/png' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(500);
    expect(put).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledOnce();
    const deletedKey = del.mock.calls[0][0] as string;
    expect(deletedKey).toMatch(/^images\/[a-z0-9]+\.png$/);
  });

  it('returns 500 and does not insert when R2 put throws', async () => {
    const { Bindings, executionCtx, calls } = mockEnv({ putThrows: true });
    const form = new FormData();
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'q.png', { type: 'image/png' }));
    const res = await assets.request('/', { method: 'POST', body: form }, Bindings, executionCtx);
    expect(res.status).toBe(500);
    expect(calls.some((c) => /insert into source_asset/i.test(c.sql))).toBe(false);
  });

  it('rejects missing file', async () => {
    const { Bindings, executionCtx } = mockEnv();
    const res = await assets.request(
      '/',
      { method: 'POST', body: new FormData() },
      Bindings,
      executionCtx,
    );
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
