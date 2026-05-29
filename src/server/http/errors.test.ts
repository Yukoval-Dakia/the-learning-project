import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, errorResponse } from './errors';

describe('ApiError + errorResponse', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('passes through the configured status + code + message for ApiError', async () => {
    const res = errorResponse(new ApiError('validation_error', 'bad input', 400));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'validation_error', message: 'bad input' });
    expect(errorSpy).not.toHaveBeenCalled();
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

  it('still logs the real message + stack server-side for an unknown error', async () => {
    const err = new Error('kaboom: secret detail');
    errorResponse(err);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      'unhandled error',
      expect.objectContaining({ message: 'kaboom: secret detail', stack: err.stack }),
    );
  });

  it('returns a generic 500 body for a non-Error throw', async () => {
    const res = errorResponse('weird string throw');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'internal_error', message: 'Internal Server Error' });
    expect(JSON.stringify(body)).not.toContain('weird string throw');
    // the real detail still reaches the server log
    expect(errorSpy).toHaveBeenCalledWith(
      'unhandled error',
      expect.objectContaining({ message: 'weird string throw' }),
    );
  });

  it('defaults ApiError status to 400 when not provided', () => {
    expect(new ApiError('x', 'y').status).toBe(400);
  });
});
