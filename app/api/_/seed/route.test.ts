import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../../../../tests/helpers/db';
import { buildAuthedRequest } from '../../../../tests/helpers/request';
import { POST } from './route';

describe('POST /api/_/seed', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns 200 with inserted count on first run', async () => {
    process.env.INTERNAL_TOKEN = 'test-token';
    const res = await POST(buildAuthedRequest('http://localhost/api/_/seed', { method: 'POST' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.inserted).toBeGreaterThan(0);
    expect(body.skipped).toBe(0);
  });

  it('is idempotent on second run', async () => {
    process.env.INTERNAL_TOKEN = 'test-token';
    await POST(buildAuthedRequest('http://localhost/api/_/seed', { method: 'POST' }));
    const res = await POST(buildAuthedRequest('http://localhost/api/_/seed', { method: 'POST' }));
    const body = await res.json();
    expect(body.inserted).toBe(0);
    expect(body.skipped).toBeGreaterThan(0);
  });
});
