import { describe, expect, it } from 'vitest';
import { deprecatedRouteResponse } from './http';

describe('deprecatedRouteResponse', () => {
  it('preserves the response while advertising a canonical successor', async () => {
    const original = Response.json(
      { ok: true },
      { status: 202, headers: { 'x-request-id': 'req_1' } },
    );

    const response = deprecatedRouteResponse(original, '/api/papers');

    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('x-request-id')).toBe('req_1');
    expect(response.headers.get('deprecation')).toBe('@1783987200');
    expect(response.headers.get('link')).toBe('</api/papers>; rel="successor-version"');
    expect(await response.json()).toEqual({ ok: true });
  });
});
