import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  recover: vi.fn(async () => []),
  close: vi.fn((done: () => void) => done()),
  end: vi.fn(async () => undefined),
  workerEnabled: false,
  startWorker: vi.fn(async (): Promise<void> => undefined),
  getBoss: vi.fn<() => unknown>(() => null),
  drain: vi.fn(async () => undefined),
  serve: vi.fn((_options: unknown, onListen: (info: { port: number }) => void) => {
    mocks.order.push('serve');
    onListen({ port: 8787 });
    return { close: mocks.close, closeAllConnections: vi.fn() };
  }),
}));

vi.mock('@hono/node-server', () => ({ serve: mocks.serve }));
vi.mock('@hono/node-server/serve-static', () => ({ serveStatic: vi.fn() }));
vi.mock('@/capabilities', () => ({ capabilities: [] }));
vi.mock('@/server/ai/runtime-preflight', () => ({ assertAgentSdkRuntimeUser: vi.fn() }));
vi.mock('@/server/projections/sot-flag', () => ({ warnFlipOrder: vi.fn() }));
vi.mock('./env', () => ({ loadApiEnv: () => ({ RW_WORKER: mocks.workerEnabled ? '1' : '0' }) }));
vi.mock('./app', () => ({ buildHonoApp: () => ({ fetch: vi.fn(), get: vi.fn(), use: vi.fn() }) }));
vi.mock('@/db/client', () => ({ db: { $client: { end: mocks.end } } }));
vi.mock('@/server/boss/client', () => ({ getRunningBoss: mocks.getBoss }));
vi.mock('@/server/boss/start-worker', () => ({ startBossWorker: mocks.startWorker }));
vi.mock('@/server/boss/shutdown', () => ({ stopBossGracefully: mocks.drain }));
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
  const handlers = new Map<string | symbol, (...args: unknown[]) => unknown>();
  beforeEach(() => {
    vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return process;
    });
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  });
  afterEach(() => {
    mocks.order.length = 0;
    mocks.recover.mockClear();
    mocks.serve.mockClear();
    mocks.close.mockClear();
    mocks.end.mockClear();
    mocks.workerEnabled = false;
    mocks.startWorker.mockReset().mockResolvedValue(undefined);
    mocks.getBoss.mockReset().mockReturnValue(null);
    mocks.drain.mockReset().mockResolvedValue(undefined);
    handlers.clear();
    vi.restoreAllMocks();
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

  it('owns SIGTERM in API-only production and drains HTTP before closing the DB', async () => {
    const handlers = new Map<string | symbol, (...args: unknown[]) => unknown>();
    const on = vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return process;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    try {
      await import('./index');
      await vi.waitFor(() => expect(mocks.serve).toHaveBeenCalledTimes(1));
      expect(handlers.has('SIGTERM')).toBe(true);
      await handlers.get('SIGTERM')?.('SIGTERM');
      expect(mocks.close).toHaveBeenCalledTimes(1);
      expect(mocks.end).toHaveBeenCalledTimes(1);
      expect(mocks.close.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.end.mock.invocationCallOrder[0],
      );
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      on.mockRestore();
      exit.mockRestore();
    }
  });

  it('waits for an in-process worker still starting before releasing the DB', async () => {
    mocks.workerEnabled = true;
    let ready = () => {};
    mocks.startWorker.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    await import('./index');
    await vi.waitFor(() => expect(mocks.startWorker).toHaveBeenCalledTimes(1));
    const stopped = handlers.get('SIGTERM')?.('SIGTERM');
    await Promise.resolve();
    expect(mocks.end).not.toHaveBeenCalled();
    const boss = { queues: ['copilot_run', 'note_verify', 'memory_reconcile'] };
    mocks.getBoss.mockReturnValue(boss);
    ready();
    await stopped;
    expect(mocks.drain).toHaveBeenCalledExactlyOnceWith(boss, 'API shutdown');
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(mocks.drain.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.end.mock.invocationCallOrder[0],
    );
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('closes the database and reports failure if a request-started boss fails to drain', async () => {
    mocks.getBoss.mockReturnValue({ queues: [], role: 'request-producer' });
    mocks.drain.mockRejectedValueOnce(new Error('boss shutdown failed'));
    await import('./index');
    await vi.waitFor(() => expect(mocks.serve).toHaveBeenCalledTimes(1));
    await handlers.get('SIGTERM')?.('SIGTERM');
    expect(mocks.drain).toHaveBeenCalledTimes(1);
    expect(mocks.end).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
