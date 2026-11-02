import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityManifest } from '@/kernel/manifest';
import { buildHonoApp } from './app';

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
    ],
  },
};

describe('buildHonoApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

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
});
