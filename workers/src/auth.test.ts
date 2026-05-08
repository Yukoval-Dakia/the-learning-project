import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { internalAuth } from './auth';
import type { AppEnv } from './types';

describe('internalAuth middleware', () => {
  function makeApp() {
    const app = new Hono<AppEnv>();
    app.use('/api/*', internalAuth);
    app.get('/api/ping', (c) => c.json({ ok: true }));
    return app;
  }

  const env = { INTERNAL_TOKEN: 'secret-token' } as unknown as AppEnv['Bindings'];

  it('returns 401 when header missing', async () => {
    const app = makeApp();
    const res = await app.request('/api/ping', {}, env);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when token wrong', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/ping',
      { headers: { 'x-internal-token': 'wrong-token' } },
      env,
    );
    expect(res.status).toBe(401);
  });

  it('passes through when token matches', async () => {
    const app = makeApp();
    const res = await app.request(
      '/api/ping',
      { headers: { 'x-internal-token': 'secret-token' } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
