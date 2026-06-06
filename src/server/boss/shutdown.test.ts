import type { PgBoss } from 'pg-boss';
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// closeRedis is a no-op when no client was ever created, but we mock it so the
// shutdown handler doesn't reach into ioredis during the unit test.
vi.mock('@/server/redis/client', () => ({
  closeRedis: vi.fn(async () => undefined),
}));

import { installShutdownHandler } from './shutdown';

type WorkerState = 'created' | 'active' | 'stopping' | 'stopped';

function wip(name: string, state: WorkerState, count: number) {
  return { name, state, count } as ReturnType<PgBoss['getWipData']>[number];
}

describe('installShutdownHandler (YUK-241)', () => {
  // Broad MockInstance type — the concrete spy types for process.exit /
  // process.on / console.* differ enough that a shared `ReturnType<typeof
  // vi.spyOn>` annotation rejects them; MockInstance is the common supertype.
  let exitSpy: MockInstance;
  let logSpy: MockInstance;
  let warnSpy: MockInstance;
  let errorSpy: MockInstance;
  const registered: Record<string, (signal: NodeJS.Signals) => void> = {};
  let onSpy: MockInstance;

  beforeEach(() => {
    // process.exit must not actually exit the test runner.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      // swallow — never returns in prod, but the test must keep running.
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    onSpy = vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      cb: (signal: NodeJS.Signals) => void,
    ) => {
      registered[event] = cb;
      return process;
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    onSpy.mockRestore();
  });

  it('registers SIGTERM + SIGINT handlers', () => {
    const boss = {
      stop: vi.fn(async () => undefined),
      getWipData: vi.fn(() => []),
    } as unknown as PgBoss;

    installShutdownHandler(boss);

    expect(registered.SIGTERM).toBeTypeOf('function');
    expect(registered.SIGINT).toBeTypeOf('function');
  });

  it('stops gracefully and exits 0 when no work is in flight', async () => {
    const stop = vi.fn(async () => undefined);
    const boss = { stop, getWipData: vi.fn(() => []) } as unknown as PgBoss;

    installShutdownHandler(boss);
    await registered.SIGTERM('SIGTERM');

    expect(stop).toHaveBeenCalledWith({ graceful: true, timeout: 30_000 });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('warns with the interrupted queues when stop returns with work still active', async () => {
    // First snapshot (before stop): note_generate is mid-job. After stop
    // resolves (graceful timeout), it is STILL active → interrupted.
    const getWipData = vi
      .fn()
      .mockReturnValueOnce([wip('note_generate', 'active', 1)])
      .mockReturnValueOnce([wip('note_generate', 'active', 1)]);
    const stop = vi.fn(async () => undefined);
    const boss = { stop, getWipData } as unknown as PgBoss;

    installShutdownHandler(boss);
    await registered.SIGINT('SIGINT');

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('graceful timeout reached'), {
      interrupted: [{ name: 'note_generate', count: 1 }],
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('logs interrupted queues and exits 1 when stop rejects (timeout)', async () => {
    const getWipData = vi
      .fn()
      .mockReturnValueOnce([wip('quiz_gen', 'active', 1)])
      .mockReturnValueOnce([wip('quiz_gen', 'stopping', 1)]);
    const stop = vi.fn(async () => {
      throw new Error('graceful timeout exceeded');
    });
    const boss = { stop, getWipData } as unknown as PgBoss;

    installShutdownHandler(boss);
    await registered.SIGTERM('SIGTERM');

    expect(errorSpy).toHaveBeenCalledWith('[boss] error during shutdown', expect.any(Error), {
      interrupted: [{ name: 'quiz_gen', count: 1 }],
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('ignores idle workers (count 0) and already-stopped workers in the snapshot', async () => {
    const getWipData = vi
      .fn()
      .mockReturnValueOnce([
        wip('echo', 'active', 0), // idle worker — not in flight
        wip('note_verify', 'stopped', 1), // already stopped — filtered by getWipData semantics, defensive here
      ])
      .mockReturnValueOnce([]);
    const stop = vi.fn(async () => undefined);
    const boss = { stop, getWipData } as unknown as PgBoss;

    installShutdownHandler(boss);
    await registered.SIGTERM('SIGTERM');

    // before-snapshot was effectively empty → no inFlight object logged, no warn.
    expect(warnSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('survives getWipData throwing (observability must not block shutdown)', async () => {
    const getWipData = vi.fn(() => {
      throw new Error('boom');
    });
    const stop = vi.fn(async () => undefined);
    const boss = { stop, getWipData } as unknown as PgBoss;

    installShutdownHandler(boss);
    await registered.SIGTERM('SIGTERM');

    expect(stop).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('is idempotent — a second signal is a no-op', async () => {
    const stop = vi.fn(async () => undefined);
    const boss = { stop, getWipData: vi.fn(() => []) } as unknown as PgBoss;

    installShutdownHandler(boss);
    await registered.SIGTERM('SIGTERM');
    await registered.SIGTERM('SIGTERM');

    expect(stop).toHaveBeenCalledTimes(1);
  });
});
