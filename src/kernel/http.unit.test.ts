import { describe, expect, it } from 'vitest';
import {
  ApiError,
  HTTP_CONTRACT_STATUS,
  canonicalResourceResponse,
  collectionPayload,
  deprecatedRouteResponse,
  errorResponse,
  resourceResponse,
} from './http';

describe('HTTP resource contract', () => {
  it.each([
    ['created', HTTP_CONTRACT_STATUS.created],
    ['existing', 200],
    ['accepted', HTTP_CONTRACT_STATUS.accepted],
  ] as const)('maps %s to its status and a readable Location', (outcome, status) => {
    const response = resourceResponse(
      { id: 'resource-1' },
      { outcome, location: '/api/resources/resource-1' },
    );

    expect(response.status).toBe(status);
    expect(response.headers.get('location')).toBe('/api/resources/resource-1');
  });

  it('upgrades a successful legacy response without reshaping its body', async () => {
    const response = await canonicalResourceResponse(Response.json({ id: 'event-1' }), {
      outcome: 'created',
      location: (body) => `/api/events/${(body as { id: string }).id}`,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get('location')).toBe('/api/events/event-1');
    expect(await response.json()).toEqual({ id: 'event-1' });
  });

  it('passes legacy errors through unchanged', async () => {
    const original = Response.json({ error: 'conflict' }, { status: 409 });
    const response = await canonicalResourceResponse(original, {
      outcome: 'created',
      location: '/api/resources/unused',
    });

    expect(response).toBe(original);
    expect(response.status).toBe(409);
  });

  it.each([
    ['not_found', HTTP_CONTRACT_STATUS.notFound],
    ['conflict', HTTP_CONTRACT_STATUS.conflict],
    ['semantic_validation', HTTP_CONTRACT_STATUS.semanticValidation],
    ['rate_limited', HTTP_CONTRACT_STATUS.rateLimited],
  ] as const)('keeps the %s error boundary at %i', (code, status) => {
    const response = errorResponse(new ApiError(code, 'contract error', status));
    expect(response.status).toBe(status);
  });

  it('builds the canonical collection envelope with migration aliases', () => {
    expect(
      collectionPayload(
        [{ id: 'row-1' }],
        { limit: 50, next_cursor: 'next' },
        {
          rows: [{ id: 'row-1' }],
        },
      ),
    ).toEqual({
      data: [{ id: 'row-1' }],
      page: { limit: 50, next_cursor: 'next' },
      rows: [{ id: 'row-1' }],
    });
  });
});

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
