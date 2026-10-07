// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/ui/lib/api';

import { useResponseDraftAutosave } from './useResponseDraftAutosave';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useResponseDraftAutosave', () => {
  it('cancels a queued draft when the host starts final submission and resumes only when enabled', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { rerender } = renderHook(
      ({ value, enabled }) => useResponseDraftAutosave({ value, enabled, save, debounceMs: 15 }),
      { initialProps: { value: 'original', enabled: true } },
    );
    rerender({ value: 'accepted answer', enabled: true });
    rerender({ value: 'accepted answer', enabled: false });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
    });
    expect(save).not.toHaveBeenCalled();
    rerender({ value: 'accepted answer', enabled: true });
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
  });

  it('does not count equivalent value objects as repeated edits while awaiting acknowledgement', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ value }) => useResponseDraftAutosave({ value, save, debounceMs: 15 }),
      { initialProps: { value: { answer: 'original' } } },
    );
    rerender({ value: { answer: 'edited' } });
    rerender({ value: { answer: 'edited' } });
    expect(result.current.generation).toBe(1);
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
  });

  it('an older acknowledgement cannot mark a newer failed draft clean', async () => {
    let acknowledge!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            acknowledge = resolve;
          }),
      )
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ value }) => useResponseDraftAutosave({ value, save, debounceMs: 5 }),
      { initialProps: { value: 'initial' } },
    );
    rerender({ value: 'first edit' });
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    rerender({ value: 'newest edit' });
    await act(async () => {
      acknowledge();
    });
    await waitFor(() => expect(result.current.state).toBe('error'));
    act(() => {
      void result.current.flush({ keepalive: true });
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
    expect(save).toHaveBeenLastCalledWith('newest edit', { keepalive: true });
  });
  it('treats the initial value as restored baseline and marks saved only after acknowledgement', async () => {
    let acknowledge!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ value }) => useResponseDraftAutosave({ value, save, debounceMs: 5 }),
      { initialProps: { value: { q1: 'restored' } } },
    );
    expect(result.current.state).toBe('idle');
    rerender({ value: { q1: 'changed' } });
    await waitFor(() => expect(save).toHaveBeenCalledWith({ q1: 'changed' }, { keepalive: false }));
    expect(result.current.state).toBe('saving');
    await act(async () => {
      acknowledge();
      await Promise.resolve();
    });
    expect(result.current.state).toBe('saved');
    expect(result.current.generation).toBe(1);
    expect(result.current.lastSavedAt).not.toBeNull();
  });

  it('maps 409 to conflict and retries explicitly', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new ApiError('stale', 409))
      .mockResolvedValueOnce({ ok: true });
    const { result, rerender } = renderHook(
      ({ value }) => useResponseDraftAutosave({ value, save, debounceMs: 5 }),
      { initialProps: { value: 'baseline' } },
    );
    rerender({ value: 'new' });
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    await waitFor(() => expect(result.current.state).toBe('conflict'));
    act(() => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.state).toBe('saved'));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('flush sends the latest dirty value with keepalive, but does not write clean baseline', async () => {
    const save = vi.fn().mockResolvedValue({ ok: true });
    const { result, rerender } = renderHook(
      ({ value }) => useResponseDraftAutosave({ value, save, debounceMs: 10000 }),
      { initialProps: { value: 'baseline' } },
    );
    act(() => {
      result.current.flush({ keepalive: true });
    });
    expect(save).not.toHaveBeenCalled();
    rerender({ value: 'final answer' });
    act(() => {
      result.current.flush({ keepalive: true });
    });
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledWith('final answer', { keepalive: true });
  });
});
