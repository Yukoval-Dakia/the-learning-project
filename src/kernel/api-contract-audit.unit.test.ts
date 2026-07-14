import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertApiRouteContractCoverage, auditApiRouteContracts } from './api-contract-audit';
import type { CapabilityManifest } from './manifest';

function capability(routes: NonNullable<CapabilityManifest['api']>['routes']) {
  return [{ name: 'test', description: 'test', api: { routes } }] as CapabilityManifest[];
}

describe('API route contract coverage audit', () => {
  it('accepts a declared route and an explicitly allowlisted legacy route', () => {
    const capabilities = capability([
      {
        method: 'GET',
        path: '/api/declared',
        operationId: 'getDeclared',
        successStatus: 200,
        responses: { 200: z.object({ ok: z.boolean() }) },
      },
      { method: 'GET', path: '/api/legacy' },
    ]);
    expect(
      assertApiRouteContractCoverage(capabilities, {
        'GET /api/legacy': 'legacy projection pending schema migration',
      }),
    ).toMatchObject({ total: 2, declared: 1, legacy: 1, errors: [] });
  });

  it('reports missing, stale and unknown allowlist entries', () => {
    const capabilities = capability([
      {
        method: 'GET',
        path: '/api/declared',
        operationId: 'getDeclared',
        successStatus: 200,
        responses: { 200: z.unknown() },
      },
      { method: 'GET', path: '/api/legacy' },
    ]);
    const report = auditApiRouteContracts(capabilities, {
      'GET /api/declared': 'stale entry after migration',
      'GET /api/missing': 'route was removed from the manifest',
    });
    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('stale legacy allowlist entry'),
        expect.stringContaining('GET /api/legacy'),
        expect.stringContaining('has no manifest route'),
      ]),
    );
  });
});
