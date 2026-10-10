import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorResponse } from './errors';

describe('ApiError + errorResponse', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns a generic 500 body for an unknown error and never leaks the raw message', async () => {
    const res = errorResponse(new Error('kaboom: secret db host db-prod-internal:5432'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
    // raw exception text must not appear anywhere in the client payload
    expect(JSON.stringify(body)).not.toContain('kaboom');
    expect(JSON.stringify(body)).not.toContain('db-prod-internal');
  });
});
