import { afterEach, describe, expect, it, vi } from 'vitest';
import { settleWithAcceptanceDeadline } from './deadline';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('actual acceptance deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts timely success and clears the Stop timer', async () => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    await expect(settleWithAcceptanceDeadline(async () => 'done', stop, 90)).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(180);
    expect(stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a late success, waiting for both execution and Stop before teardown', async () => {
    vi.useFakeTimers();
    const execution = deferred<string>();
    const stopped = deferred<void>();
    const stop = vi.fn(() => stopped.promise);
    const outcome = settleWithAcceptanceDeadline(() => execution.promise, stop, 90).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const settled = vi.fn();
    void outcome.then(settled);
    await vi.advanceTimersByTimeAsync(90);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(settled).not.toHaveBeenCalled();
    execution.resolve('late done');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    stopped.resolve();
    expect(await outcome).toMatchObject({
      error: { message: expect.stringContaining('deadline') },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves an execution failure before the deadline without issuing Stop', async () => {
    vi.useFakeTimers();
    const failure = new Error('execution failed before terminal');
    const stop = vi.fn(async () => {});
    await expect(
      settleWithAcceptanceDeadline(
        async () => {
          throw failure;
        },
        stop,
        90,
      ),
    ).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(180);
    expect(stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not detach execution when Stop fails, and preserves failure as a cause', async () => {
    vi.useFakeTimers();
    const execution = deferred<string>();
    const failure = new Error('Stop unavailable');
    const outcome = settleWithAcceptanceDeadline(
      () => execution.promise,
      async () => {
        throw failure;
      },
      90,
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    const settled = vi.fn();
    void outcome.then(settled);
    await vi.advanceTimersByTimeAsync(90);
    expect(settled).not.toHaveBeenCalled();
    execution.resolve('late done');
    expect(await outcome).toMatchObject({
      error: { message: expect.stringContaining('deadline'), cause: failure },
    });
  });
});
