import { describe, expect, it } from 'vitest';
import { ApiError, errorResponse } from './errors';

describe('ApiError + errorResponse', () => {
  it('returns the configured status + code + message for ApiError', async () => {
    const res = errorResponse(new ApiError('validation_error', 'bad input', 400));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: 'validation_error', message: 'bad input' });
  });

  it('returns 500 internal_error for an unknown error instance', async () => {
    const res = errorResponse(new Error('kaboom'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
    expect(body.message).toBe('kaboom');
  });

  it('returns 500 internal_error for a non-Error throw', async () => {
    const res = errorResponse('weird string throw');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('internal_error');
  });

  it('defaults ApiError status to 400 when not provided', () => {
    expect(new ApiError('x', 'y').status).toBe(400);
  });
});
