import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminConfigRuntimeFacts } from '@/capabilities/observability/public';
import { buildHonoApp } from '../app';
import { controlConfig, controlRuntime } from './admin-control-test-fixtures';

const access = vi.hoisted(() => ({ database: vi.fn() }));
vi.mock('@/db/client', () => ({
  get db() {
    access.database();
    return {};
  },
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});
describe('request-context operation identity across isolated host and Start module graphs', () => {
  it('keeps canonical injected facts, hot snapshots, writer and error class despite an uninjected duplicate', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'identity-token');
    vi.stubEnv('XIAOMI_API_KEY', 'identity-secret-canary');
    access.database.mockClear();
    const hostKernel = await import('@/kernel/http');
    const canonical = await import('@/capabilities/observability/public');
    const store = await import('@/core/config/store');
    const { createFrontdoorContext } = await import('../frontdoor');
    const hostGate = await import('./admin-control-read');
    const fixture = controlConfig();
    const facts: AdminConfigRuntimeFacts = {
      global_pin: null,
      task_bindings: {},
      providers: fixture.providers,
      infra_schedules: [],
      runtime: controlRuntime,
      effective_values: {},
    };
    const factsSource = vi.fn(() => facts);
    canonical.setAdminConfigRuntimeFacts(factsSource);
    store.replaceConfigSnapshot({
      epoch: 71,
      hydratedAt: '2026-10-09T00:00:00Z',
      entries: new Map([['locale.learner', { value: 'en', revision: 8, updatedAt: null }]]),
    });
    const receipt = {
      committed_epoch: 72,
      snapshot_epoch: 71,
      snapshot_current: false,
      changes: [],
    };
    const writer = vi.fn(async () => receipt);
    canonical.setAdminConfigWriter(writer);
    const context = createFrontdoorContext(
      buildHonoApp([], { epochGate: async () => ({ runnable: true }) }),
      'unused-spa',
    );
    const request = new Request('http://unit.test/_serverFn/identity', {
      headers: { 'x-internal-token': 'identity-token' },
    });
    const first = await hostGate.runAuthenticatedStartAdminControl(context, request, (c) =>
      c.getConfig(),
    );
    expect(first.facts_injected).toBe(true);
    expect(first.snapshot.epoch).toBe(71);
    // Resetting Vitest's module registry creates a second graph with different
    // singleton and ApiError identities. The real frontdoor retains only host
    // operation bindings, never any DTO or credential material.
    vi.resetModules();
    const duplicate = await import('@/capabilities/observability/public');
    expect(duplicate.getAdminConfigRuntimeFacts()).toBeNull();
    expect(duplicate.buildAdminConfigReadModel({}).snapshot.epoch).toBe(0);
    await expect(
      duplicate.patchAdminConfig({
        changes: [{ action: 'set', key: 'locale.learner', value: 'en' }],
      }),
    ).rejects.toMatchObject({ code: 'config_writer_unavailable', status: 503 });
    const startGate = await import('./admin-control-read');
    expect(
      await startGate.runAuthenticatedStartAdminControl(context, request, (c) =>
        c.patchConfig({ changes: [{ action: 'set', key: 'locale.learner', value: 'en' }] }),
      ),
    ).toEqual(receipt);
    expect(writer).toHaveBeenCalledExactlyOnceWith(
      [{ action: 'set', key: 'locale.learner', value: 'en' }],
      undefined,
    );
    store.replaceConfigSnapshot({
      epoch: 73,
      hydratedAt: '2026-10-09T00:01:00Z',
      entries: new Map(),
    });
    const current = await startGate.runAuthenticatedStartAdminControl(context, request, (c) =>
      c.getConfig(),
    );
    expect(current.snapshot.epoch).toBe(73);
    expect(current.providers).toEqual(first.providers);
    expect(factsSource).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(current)).not.toContain('identity-secret-canary');
    const duplicateKernel = await import('@/kernel/http');
    expect(duplicateKernel.ApiError).not.toBe(hostKernel.ApiError);
    writer.mockRejectedValueOnce(
      new hostKernel.ApiError('config_pinned', 'Configuration is pinned', 422),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed: unknown = await startGate
      .runAuthenticatedStartAdminControl(context, request, (c) =>
        c.resetConfig({ keys: ['locale.learner'] }),
      )
      .catch((e: unknown) => e);
    if (!(failed instanceof Response)) throw new Error('Expected shaped host Response');
    expect(failed.status).toBe(422);
    expect(await failed.json()).toEqual({
      error: 'config_pinned',
      message: 'Configuration is pinned',
    });
    log.mockRestore();
    expect(writer).toHaveBeenCalledTimes(2);
    expect(access.database).not.toHaveBeenCalled();
  });
  it('resolves no canonical bindings for denied requests and keeps actual uninjected states honest', async () => {
    vi.stubEnv('INTERNAL_TOKEN', 'identity-token');
    const { createFrontdoorContext } = await import('../frontdoor');
    const { runAuthenticatedStartAdminControl } = await import('./admin-control-read');
    const context = createFrontdoorContext(
      buildHonoApp([], { epochGate: async () => ({ runnable: true }) }),
      'unused-spa',
    );
    const denied: unknown = await runAuthenticatedStartAdminControl(
      context,
      new Request('http://unit.test/_serverFn/identity'),
      (c) => c.getConfig(),
    ).catch((e: unknown) => e);
    if (!(denied instanceof Response)) throw new Error('Expected Response');
    expect(denied.status).toBe(401);
    const controls = await context.adminControls();
    const domain = await import('@/capabilities/observability/public');
    domain.__resetAdminConfigRuntimeFactsForTests();
    const { __resetAdminConfigWriterForTests } = await import(
      '@/capabilities/observability/server/admin-config-writer'
    );
    __resetAdminConfigWriterForTests();
    expect((await controls.getConfig()).facts_injected).toBe(false);
    const error: unknown = await controls
      .patchConfig({ changes: [{ action: 'set', key: 'locale.learner', value: 'en' }] })
      .catch((e: unknown) => e);
    if (!(error instanceof Response)) throw new Error('Expected Response');
    expect(error.status).toBe(503);
    expect(await error.json()).toMatchObject({ error: 'config_writer_unavailable' });
  });
});
