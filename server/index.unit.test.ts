import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  recover: vi.fn(async () => []),
  serve: vi.fn((_options: unknown, onListen: (info: { port: number }) => void) => {
    mocks.order.push('serve');
    onListen({ port: 8787 });
  }),
}));

vi.mock('@hono/node-server', () => ({ serve: mocks.serve }));
vi.mock('@hono/node-server/serve-static', () => ({ serveStatic: vi.fn() }));
vi.mock('@/capabilities', () => ({ capabilities: [] }));
vi.mock('@/server/ai/runtime-preflight', () => ({ assertAgentSdkRuntimeUser: vi.fn() }));
vi.mock('@/server/projections/sot-flag', () => ({ warnFlipOrder: vi.fn() }));
vi.mock('./env', () => ({ loadApiEnv: () => ({}) }));
vi.mock('./app', () => ({ buildHonoApp: () => ({ fetch: vi.fn(), get: vi.fn(), use: vi.fn() }) }));
vi.mock('@/db/client', () => ({ db: {} }));
vi.mock('@/server/subjects/hydrate', () => ({
  hydrateSubjectRegistryFromDb: vi.fn(async () => ({ hydrated: [], skipped: [] })),
}));
vi.mock('@/server/ai/tools/register-capability-tools', () => ({
  registerCapabilityTools: vi.fn(async () => undefined),
}));
vi.mock('@/kernel/tools/tool-operations', () => ({
  recoverToolOperationsOnBoot: mocks.recover.mockImplementation(async () => {
    mocks.order.push('tool-operations-recovered');
    return [];
  }),
}));

describe('API startup', () => {
  afterEach(() => {
    mocks.order.length = 0;
    mocks.recover.mockClear();
    mocks.serve.mockClear();
    vi.resetModules();
  });

  it('recovers ToolOperations before opening the HTTP listener', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await import('./index');
    await vi.waitFor(() => expect(mocks.serve).toHaveBeenCalledTimes(1));

    expect(mocks.order).toEqual(['tool-operations-recovered', 'serve']);
    expect(mocks.recover).toHaveBeenCalledTimes(1);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});
