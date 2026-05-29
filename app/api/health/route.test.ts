import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB client BEFORE importing the route so this runs in the UNIT
// partition (no Docker / live Postgres). `db.execute` is the only thing the
// health probe touches.
const execute = vi.fn();
vi.mock('@/db/client', () => ({ db: { execute } }));

const { GET } = await import('./route');

describe('GET /api/health', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    execute.mockReset();
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns 200 { ok: true, db_ok: true } when the DB probe succeeds', async () => {
    execute.mockResolvedValue([{ ok: 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, db_ok: true });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('returns 503 and leaks no DB exception detail when the probe fails', async () => {
    execute.mockRejectedValue(
      new Error('connect ECONNREFUSED db-prod-internal:5432 — password authentication failed'),
    );
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    // liveness contract preserved: still { ok: true, db_ok: false } and 503
    expect(body).toEqual({ ok: true, db_ok: false });
    // no db_error / code / message of any kind in the public payload
    expect(body).not.toHaveProperty('db_error');
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('message');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('ECONNREFUSED');
    expect(serialized).not.toContain('db-prod-internal');
    expect(serialized).not.toContain('password');
    // the real detail is still logged server-side
    expect(errorSpy).toHaveBeenCalledWith(
      'health: db check failed',
      expect.objectContaining({
        message: expect.stringContaining('ECONNREFUSED'),
      }),
    );
  });
});
