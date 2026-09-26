// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ apiJson: vi.fn() }));
vi.mock('@/ui/lib/api', () => api);

import { useJudgeRunPolling } from './useJudgeRunPolling';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useJudgeRunPolling', () => {
  it('polls the same run URL until terminal done, without resubmitting', async () => {
    api.apiJson
      .mockResolvedValueOnce({ run_id: 'run-1', status: 'queued', result: null })
      .mockResolvedValueOnce({
        run_id: 'run-1',
        status: 'done',
        result: { attempt_event_id: 'attempt-1', coarse_outcome: 'correct' },
      });
    const { result } = renderHook(() =>
      useJudgeRunPolling({
        runId: 'run-1',
        pollUrl: '/api/test/run-1',
        intervalMs: 5,
        maxIntervalMs: 5,
      }),
    );
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(api.apiJson.mock.calls.map(([url]) => url)).toEqual([
      '/api/test/run-1',
      '/api/test/run-1',
    ]);
    expect(result.current.result?.attempt_event_id).toBe('attempt-1');
    expect(result.current.settled).toBe(true);
  });

  it('uses an encoded run-id fallback path, and stops after failed terminal status', async () => {
    api.apiJson.mockResolvedValue({ run_id: 'run/a', status: 'failed', result: null });
    const { result } = renderHook(() =>
      useJudgeRunPolling({ runId: 'run/a', intervalMs: 5, maxIntervalMs: 5 }),
    );
    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(api.apiJson).toHaveBeenCalledOnce();
    expect(api.apiJson).toHaveBeenCalledWith('/api/jobs/judge_run/run%2Fa/status');
    expect(result.current.settled).toBe(true);
  });
});
