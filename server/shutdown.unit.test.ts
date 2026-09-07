import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApiShutdown } from './shutdown';

describe('API shutdown deadlines', () => {
  const handlers = new Map<string | symbol, (...args: unknown[]) => unknown>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process, 'on').mockImplementation((event, handler) => {
      handlers.set(event, handler);
      return process;
    });
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    handlers.clear();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('cuts off an open transport after 30s, then releases runtime exactly once', async () => {
    let closed = (_error?: Error) => {};
    const close = vi.fn((callback: (error?: Error) => void) => {
      closed = callback;
    });
    const closeAllConnections = vi.fn(() => closed());
    const runtime = vi.fn(async () => undefined);
    installApiShutdown({ close, closeAllConnections }, runtime);
    const stopping = handlers.get('SIGTERM')?.('SIGTERM');
    await handlers.get('SIGINT')?.('SIGINT');
    await vi.advanceTimersByTimeAsync(29_999);
    expect(runtime).not.toHaveBeenCalled();
    expect(closeAllConnections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(runtime).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not report a rejected runtime cleanup as clean', async () => {
    installApiShutdown({ close: (done) => done() }, async () => {
      throw new Error('pool shutdown failed');
    });
    await handlers.get('SIGTERM')?.('SIGTERM');
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a runtime cleanup that never settles', async () => {
    installApiShutdown({ close: (done) => done() }, () => new Promise(() => {}));
    void handlers.get('SIGTERM')?.('SIGTERM');
    await vi.advanceTimersByTimeAsync(64_999);
    expect(process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

it('real SIGTERM stops admission but lets an in-flight HTTP response finish before process exit', async () => {
  const code = buildSync({
    stdin: {
      contents: `
        import {createServer} from 'node:http';
        import {installApiShutdown} from ${JSON.stringify(resolve('server/shutdown.ts'))};
        const server = createServer((req,res) => {
          process.send({kind:'inflight'});
          process.once('message', () => res.end('committed response'));
        });
        server.listen(0,'127.0.0.1',() => process.send({kind:'ready',port:server.address().port}));
        installApiShutdown(server,async () => { process.send({kind:'runtime-closed'}); });
      `,
      resolveDir: process.cwd(),
    },
    platform: 'node',
    format: 'cjs',
    bundle: true,
    write: false,
  }).outputFiles[0].text;
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  try {
    const [ready] = await once(child, 'message');
    expect(ready.kind).toBe('ready');
    const inflight = once(child, 'message');
    const response = fetch(`http://127.0.0.1:${ready.port}`, {
      signal: AbortSignal.timeout(5_000),
    });
    await inflight;
    const receivedSignal = new Promise<void>((resolve) => {
      child.stdout?.on('data', (chunk) => {
        if (chunk.toString().includes('received, draining')) resolve();
      });
    });
    child.kill('SIGTERM');
    await receivedSignal;
    expect(child.exitCode).toBeNull();
    await expect(
      fetch(`http://127.0.0.1:${ready.port}`, { signal: AbortSignal.timeout(1_000) }),
    ).rejects.toThrow();
    const closed = once(child, 'message');
    child.send('finish');
    expect(await (await response).text()).toBe('committed response');
    expect((await closed)[0]).toEqual({ kind: 'runtime-closed' });
    expect(await exited).toEqual([0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});
