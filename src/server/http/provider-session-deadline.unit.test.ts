import { describe, expect, it } from 'vitest';
import {
  currentHttpProviderSessionDeadlineAt,
  resolveProviderSessionDeadlineAt,
  runWithHttpProviderSessionDeadline,
} from './provider-session-deadline';

describe('HTTP provider-session deadline scope', () => {
  it('is absent outside an HTTP request scope', () => {
    expect(currentHttpProviderSessionDeadlineAt()).toBeUndefined();
    expect(resolveProviderSessionDeadlineAt()).toBeUndefined();
  });

  it('survives async boundaries and leaves no ambient value after completion', async () => {
    const observed = await runWithHttpProviderSessionDeadline(90_000, async () => {
      await Promise.resolve();
      return currentHttpProviderSessionDeadlineAt();
    });

    expect(observed).toBe(90_000);
    expect(currentHttpProviderSessionDeadlineAt()).toBeUndefined();
  });

  it('uses the earliest explicit, request, or nested deadline', () => {
    runWithHttpProviderSessionDeadline(90_000, () => {
      expect(resolveProviderSessionDeadlineAt()).toBe(90_000);
      expect(resolveProviderSessionDeadlineAt(80_000)).toBe(80_000);
      expect(resolveProviderSessionDeadlineAt(100_000)).toBe(90_000);

      runWithHttpProviderSessionDeadline(70_000, () => {
        expect(currentHttpProviderSessionDeadlineAt()).toBe(70_000);
      });
      expect(currentHttpProviderSessionDeadlineAt()).toBe(90_000);
    });
  });

  it('isolates overlapping sibling request scopes', async () => {
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let markFirstReady!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      markFirstReady = resolve;
    });

    const first = runWithHttpProviderSessionDeadline(90_000, async () => {
      markFirstReady();
      await holdFirst;
      return currentHttpProviderSessionDeadlineAt();
    });
    await firstReady;
    const second = await runWithHttpProviderSessionDeadline(80_000, async () => {
      await Promise.resolve();
      return currentHttpProviderSessionDeadlineAt();
    });
    releaseFirst();

    await expect(first).resolves.toBe(90_000);
    expect(second).toBe(80_000);
  });

  it('rejects a non-finite deadline instead of silently disabling the fence', () => {
    expect(() => runWithHttpProviderSessionDeadline(Number.NaN, () => {})).toThrow(RangeError);
    expect(() => resolveProviderSessionDeadlineAt(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
