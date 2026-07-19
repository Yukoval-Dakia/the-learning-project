// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The hook bails before fetch unless getInternalToken() returns a token.
vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, getInternalToken: () => 'test-token' };
});

import { isSseErrorFrame, useIngestionSSE } from './sse';

/** A fetch Response whose body streams `sseText` then closes (mimics the route). */
function streamingResponse(sseText: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sseText));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('isSseErrorFrame', () => {
  it('recognizes the server named error frame and rejects normal data frames', () => {
    expect(isSseErrorFrame('event: error\ndata: {"error":"stream_failed"}')).toBe(true);
    expect(isSseErrorFrame('id: 7\ndata: {"event_id":7,"event_type":"x","payload":{}}')).toBe(
      false,
    );
    expect(isSseErrorFrame('data: {"event_id":1}')).toBe(false);
  });
});

describe('useIngestionSSE — server error frame (round-3 fix)', () => {
  it('surfaces status="error" on a mid-stream error frame instead of a silent "closed"', async () => {
    // Regression (PR #959 round-3): the server emits `event: error` on a DB error,
    // but the client dropped the frame and reported EOF as 'closed', so VisionTab's
    // status==='error' recovery branch was unreachable and it hung on 'extracting'.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => streamingResponse('event: error\ndata: {"error":"stream_failed"}\n\n')),
    );

    const { result } = renderHook(() => useIngestionSSE('sess_err'));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBeInstanceOf(Error);
    // The internal failure code must not leak into the learner-facing message.
    expect(result.current.error?.message ?? '').not.toContain('stream_failed');
  });

  it('control: a normal frame still populates events and ends on "closed"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        streamingResponse(
          'id: 7\ndata: {"event_id":7,"event_type":"ingestion.extraction_completed","payload":{}}\n\n',
        ),
      ),
    );

    const { result } = renderHook(() => useIngestionSSE('sess_ok'));

    await waitFor(() => expect(result.current.status).toBe('closed'));
    expect(result.current.events).toHaveLength(1);
    expect(result.current.events[0].event_id).toBe(7);
    expect(result.current.error).toBeNull();
  });
});
