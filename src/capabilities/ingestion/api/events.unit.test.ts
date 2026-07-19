import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/client', () => ({ db: {} }));

const computeReplay = vi.fn();
vi.mock('@/server/events/sse_replay', () => ({
  computeReplay: (...args: unknown[]) => computeReplay(...args),
}));

const unsubscribe = vi.fn();
const subscribe = vi.fn((..._args: unknown[]) => unsubscribe);
vi.mock('@/server/events/sse_router', () => ({
  subscribe: (...args: unknown[]) => subscribe(...args),
}));

import { IngestionEventStreamResponseSchema } from './contracts';
import { GET } from './events';

/** Flush pending micro/macrotasks so an async start() runs past its first await. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Drain a ReadableStream to a single decoded string (stops when the stream closes). */
async function drainStream(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const r = await reader.read();
    if (r.value) buffer += decoder.decode(r.value, { stream: true });
    done = r.done;
  }
  return buffer;
}

describe('GET /api/ingestion/[id]/events contract', () => {
  beforeEach(() => {
    computeReplay.mockReset();
    unsubscribe.mockReset();
    subscribe.mockClear();
  });

  it('returns an SSE response and emits replay frames using the declared representation', async () => {
    computeReplay.mockResolvedValue([
      {
        id: 7,
        event_type: 'ingestion.extraction_completed',
        payload: { status: 'extracted' },
      },
    ]);
    const controller = new AbortController();
    const request = new Request('http://localhost/api/ingestion/session_1/events', {
      headers: { 'Last-Event-ID': '6' },
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_1' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    const frame = new TextDecoder().decode(first?.value);
    expect(() => IngestionEventStreamResponseSchema.parse(frame)).not.toThrow();
    expect(frame).toContain('id: 7');
    expect(frame).toContain('ingestion.extraction_completed');
    expect(computeReplay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ businessId: 'session_1', lastEventId: 6 }),
    );

    controller.abort();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('F1 NaN cursor: a non-numeric Last-Event-ID degrades to full replay (lastEventId 0), not gt(id, NaN)', async () => {
    computeReplay.mockResolvedValue([]);
    const controller = new AbortController();
    const request = new Request('http://localhost/api/ingestion/session_nan/events', {
      headers: { 'Last-Event-ID': 'not-a-number' },
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_nan' });
    expect(response.status).toBe(200);
    // Drive start() past its first await; the empty replay never enqueues, so a
    // read() would hang — flush the task queue instead.
    await flush();

    expect(computeReplay).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ businessId: 'session_nan', lastEventId: 0 }),
    );
    controller.abort();
    await (response.body as ReadableStream).cancel().catch(() => {});
  });

  it('F2 thrown computeReplay: emits an SSE error frame and closes the stream (does not hang)', async () => {
    computeReplay.mockRejectedValue(new Error('boom'));
    const controller = new AbortController();
    const request = new Request('http://localhost/api/ingestion/session_err/events', {
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_err' });
    expect(response.status).toBe(200);

    // A hang would loop forever; the runner timeout catches it, and done===true proves close.
    const buffer = await drainStream(response.body as ReadableStream<Uint8Array>);
    expect(buffer).toContain('event: error');
    // The failed initial replay must not leave a live subscription registered.
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('F4 abort before await: a pre-aborted request closes without subscribing (no sse_router leak)', async () => {
    computeReplay.mockResolvedValue([]);
    const controller = new AbortController();
    controller.abort();
    const request = new Request('http://localhost/api/ingestion/session_aborted/events', {
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_aborted' });
    expect(response.status).toBe(200);

    // Stream must be already closed (drain returns immediately) with no work done.
    const buffer = await drainStream(response.body as ReadableStream<Uint8Array>);
    expect(buffer).toBe('');
    expect(computeReplay).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('F4 disconnect leak: aborting after subscribe unsubscribes exactly once (idempotent close)', async () => {
    computeReplay.mockResolvedValue([]);
    const controller = new AbortController();
    const request = new Request('http://localhost/api/ingestion/session_leak/events', {
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_leak' });
    // Drive start() to completion so subscribe() has registered the live handler;
    // the empty replay never enqueues, so flush the task queue rather than read().
    await flush();
    expect(subscribe).toHaveBeenCalledOnce();

    controller.abort();
    // Re-dispatching abort re-invokes the listener — close() is idempotent, so the
    // subscription is torn down exactly once (no double unsubscribe).
    controller.signal.dispatchEvent(new Event('abort'));
    expect(unsubscribe).toHaveBeenCalledOnce();
    await (response.body as ReadableStream).cancel().catch(() => {});
  });
});
