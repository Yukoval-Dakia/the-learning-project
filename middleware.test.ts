import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { middleware } from './middleware';

function reqOf(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(new URL(`http://localhost${path}`), { headers });
}

describe('middleware', () => {
  beforeEach(() => {
    vi.stubEnv('INTERNAL_TOKEN', 'secret-token');
  });

  it('passes through /api/health without token', async () => {
    const res = await middleware(reqOf('/api/health'));
    expect(res).toBeUndefined();
  });

  it('returns 401 when x-internal-token is missing on /api/anything', async () => {
    const res = await middleware(reqOf('/api/learning-items'));
    expect(res?.status).toBe(401);
    const body = await res?.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 for /api/admin routes without token', async () => {
    const res = await middleware(reqOf('/api/admin/runs'));
    expect(res?.status).toBe(401);
    const body = await res?.json();
    expect(body).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 when x-internal-token does not match', async () => {
    const res = await middleware(reqOf('/api/learning-items', { 'x-internal-token': 'wrong' }));
    expect(res?.status).toBe(401);
  });

  it('rejects all /api/* when INTERNAL_TOKEN is unset', async () => {
    vi.stubEnv('INTERNAL_TOKEN', undefined);
    // Even a non-empty token must be rejected when no secret is configured.
    const res = await middleware(reqOf('/api/learning-items', { 'x-internal-token': 'anything' }));
    expect(res?.status).toBe(401);
  });

  it('passes through with matching x-internal-token', async () => {
    const res = await middleware(
      reqOf('/api/learning-items', { 'x-internal-token': 'secret-token' }),
    );
    expect(res).toBeUndefined();
  });
});
