import type { CapabilityManifest } from '@/kernel/manifest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { buildHonoApp, toHonoPath } from './app';

const fakeCapability: CapabilityManifest = {
  name: 'fake',
  description: 'test capability',
  api: {
    routes: [
      {
        method: 'GET',
        path: '/api/fake',
        load: async () => async () => Response.json({ ok: 'fake' }),
      },
      // M1 (YUK-314) — param 路由首例：组合根须把路径参数透传给 handler。
      {
        method: 'GET',
        path: '/api/fake/[id]/detail',
        load: async () => async (_req, params) => Response.json({ id: params.id }),
      },
      // 纯元数据路由（无 load）——不被挂载。
      { method: 'POST', path: '/api/fake/meta-only' },
      {
        method: 'POST',
        path: '/api/fake/bad-contract',
        operationId: 'createFakeWithBadContract',
        successStatus: 201,
        responses: { 201: z.object({ ok: z.boolean() }) },
        load: async () => async () => Response.json({ ok: true }),
      },
    ],
  },
};

describe('toHonoPath', () => {
  it('converts Next-style [id] segments to Hono :id', () => {
    expect(toHonoPath('/api/practice/[id]/submit')).toBe('/api/practice/:id/submit');
    expect(toHonoPath('/api/agents/notes')).toBe('/api/agents/notes');
  });
});

describe('buildHonoApp', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('serves /api/health without a token', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serves /api/auth/check only after token validation', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);

    expect((await app.request('/api/auth/check')).status).toBe(401);
    const valid = await app.request('/api/auth/check', {
      headers: { 'x-internal-token': 'test-token' },
    });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ ok: true });
  });

  it('rejects a mounted route without the token', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);
    const res = await app.request('/api/fake');
    expect(res.status).toBe(401);
  });

  it('serves a manifest-mounted route with the token', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);
    const res = await app.request('/api/fake', {
      headers: { 'x-internal-token': 'test-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 'fake' });
  });

  it('serves the generated OpenAPI document behind token auth', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);
    expect((await app.request('/api/openapi.json')).status).toBe(401);
    const response = await app.request('/api/openapi.json', {
      headers: { 'x-internal-token': 'test-token' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      openapi: '3.0.3',
      paths: {
        '/api/fake': { get: { 'x-contract-status': 'legacy' } },
        '/api/fake/bad-contract': {
          post: { operationId: 'createFakeWithBadContract', 'x-contract-status': 'declared' },
        },
      },
    });
  });

  it('returns a JSON 500 when a handler violates its declared success status', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);
    const response = await app.request('/api/fake/bad-contract', {
      method: 'POST',
      headers: { 'x-internal-token': 'test-token' },
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'route_contract_violation' });
  });

  it('passes path params through to the handler (M1 param route)', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);
    const res = await app.request('/api/fake/k_42/detail', {
      headers: { 'x-internal-token': 'test-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'k_42' });
  });

  it('does not mount metadata-only routes and 404s unknown paths', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);
    const meta = await app.request('/api/fake/meta-only', {
      method: 'POST',
      headers: { 'x-internal-token': 'test-token' },
    });
    expect(meta.status).toBe(404);
    const unknown = await app.request('/api/nope', {
      headers: { 'x-internal-token': 'test-token' },
    });
    expect(unknown.status).toBe(404);
    // M5 review M1：404 由 /api/* JSON 兜底返回（非框架默认），prod 下不会
    // 穿透到 serveStatic 的 index.html。
    expect(await unknown.json()).toEqual({ error: 'not_found' });
  });

  // M5 review H1：fail-closed——INTERNAL_TOKEN 未设时拒绝一切 /api/*（缺 header
  // 时 undefined !== undefined 曾放行）。/api/health 豁免不受影响。
  it('rejects every /api request when INTERNAL_TOKEN is unset (fail-closed)', async () => {
    vi.stubEnv('INTERNAL_TOKEN', undefined);
    const app = buildHonoApp([fakeCapability]);
    const noHeader = await app.request('/api/fake');
    expect(noHeader.status).toBe(401);
    const withHeader = await app.request('/api/fake', {
      headers: { 'x-internal-token': 'anything' },
    });
    expect(withHeader.status).toBe(401);
    const health = await app.request('/api/health');
    expect(health.status).toBe(200);
  });

  it('rejects an empty-string token header', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'test-token');
    const app = buildHonoApp([fakeCapability]);
    const res = await app.request('/api/fake', {
      headers: { 'x-internal-token': '' },
    });
    expect(res.status).toBe(401);
  });
});
