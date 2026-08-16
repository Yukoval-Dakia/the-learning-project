import { describe, expect, it } from 'vitest';
import { aiProposalKinds } from '@/core/schema/proposal';
import { validateComposition } from '@/kernel/manifest';
import { generateOpenApiDocument } from '@/kernel/openapi';
import { capabilities } from './index';

describe('composition root', () => {
  it('passes composition validation', () => {
    expect(() => validateComposition(capabilities)).not.toThrow();
  });

  it('generates one OpenAPI operation for every manifest route', () => {
    const document = generateOpenApiDocument(capabilities) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const generatedOperations = Object.values(document.paths).reduce(
      (count, path) => count + Object.keys(path).length,
      0,
    );
    const manifestRoutes = capabilities.reduce(
      (count, capability) => count + (capability.api?.routes.length ?? 0),
      0,
    );
    expect(generatedOperations).toBe(manifestRoutes + 3);
  });

  it('includes the agency capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('agency');
  });

  it('includes the practice capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('practice');
  });

  it('includes the ingestion capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('ingestion');
  });

  it('includes the observability capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('observability');
  });

  it('includes the shipped onboarding capability', () => {
    expect(capabilities.map((c) => c.name)).toContain('onboarding');
  });

  // YUK-579 — coverage-lattice 第五面 API + ui.page 由 observability 独家声明。
  it('observability owns GET /api/admin/coverage-lattice and its ui.page (YUK-579)', () => {
    const routeOwners = capabilities.filter((c) =>
      (c.api?.routes ?? []).some(
        (r) => r.method === 'GET' && r.path === '/api/admin/coverage-lattice',
      ),
    );
    expect(routeOwners.map((c) => c.name)).toEqual(['observability']);

    const pageOwners = capabilities.filter((c) =>
      (c.ui?.pages ?? []).some((p) => p.route === '/admin/coverage-lattice'),
    );
    expect(pageOwners.map((c) => c.name)).toEqual(['observability']);
  });

  it('declares only schema-known proposal kinds', () => {
    const declared = capabilities.flatMap((c) => c.proposals?.kinds.map((d) => d.kind) ?? []);
    const known = new Set<string>(aiProposalKinds);
    expect(declared.filter((kind) => !known.has(kind))).toEqual([]);
  });

  // M4-T4：sort 后数组相等同时覆盖「每 kind 恰好一包」——并集缺失或跨包重复声明
  // 都会让两侧排序数组不等。
  it('declares every proposal kind in exactly one owner capability', () => {
    const declared = capabilities.flatMap((c) => c.proposals?.kinds.map((d) => d.kind) ?? []);
    expect([...declared].sort()).toEqual([...aiProposalKinds].sort());
  });

  // YUK-383 — cross-capability cron stagger guard. The embed_backfill comment
  // (practice/manifest.ts) claims its 04:40 slot is staggered against the whole
  // nightly chain, INCLUDING agency goal_scope and other capabilities. The
  // practice-only manifest test can't see those, so the cross-capability part of
  // that claim is enforced here: no two scheduled jobs across ALL manifests may
  // share an identical cron slot. (Runtime is keyed by job name so a collision
  // wouldn't crash, but staggering the nightly chain is a documented invariant.)
  it('no two scheduled jobs across all capabilities share a cron slot', () => {
    const crons = capabilities.flatMap(
      (c) => c.jobs?.handlers.flatMap((h) => (h.schedule ? [h.schedule.cron] : [])) ?? [],
    );
    const seen = new Map<string, number>();
    for (const cron of crons) seen.set(cron, (seen.get(cron) ?? 0) + 1);
    const collisions = [...seen.entries()].filter(([, n]) => n > 1).map(([cron]) => cron);
    expect(collisions).toEqual([]);
  });
});
