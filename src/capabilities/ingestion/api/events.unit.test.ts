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

  it('F2 thrown computeReplay: logs, emits an SSE error frame, and closes the stream (does not hang)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
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
    // The swallowed DB error is logged (not silent) — tagged, with the session id
    // and error only, no event payload.
    expect(errorSpy).toHaveBeenCalledWith(
      '[ingestion:sse] initial replay failed',
      'session_err',
      expect.any(Error),
    );
    errorSpy.mockRestore();
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

  it('F4 abort during initial replay: aborting mid-await does not subscribe (no leak on closed stream)', async () => {
    // Regression (PR #959 round-1): if the client disconnects while the initial
    // `await computeReplay` is still pending, close() runs before `unsub` is
    // assigned, so its idempotent short-circuit can never clean up. Without the
    // `if (closed) return` guard, subscribe() still runs after the await resolves
    // and leaks a permanent sse_router subscriber onto the already-closed stream.
    let resolveReplay: (rows: unknown[]) => void = () => {};
    computeReplay.mockReturnValue(
      new Promise<unknown[]>((res) => {
        resolveReplay = res;
      }),
    );

    const controller = new AbortController();
    const request = new Request('http://localhost/api/ingestion/session_midabort/events', {
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_midabort' });
    // start() is now parked at `await computeReplay`. Disconnect before it resolves.
    controller.abort();
    // Let the replay resolve; start() resumes and hits the closed guard.
    resolveReplay([]);
    await flush();

    // No live subscription may be registered (it could never be torn down).
    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    await (response.body as ReadableStream).cancel().catch(() => {});
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

  it('F4 enqueue failure on live emit: a throw from enqueue routes through close() and unsubscribes', async () => {
    // Regression (PR #959 round-2): when enqueue throws (stream already
    // errored/closed) while a live subscription exists, the catch must run the
    // unified close() — not just set `closed` — or the idempotent gate short-
    // circuits the later close() and unsub() never fires (sse_router leak).
    computeReplay.mockResolvedValueOnce([{ id: 1, event_type: 'ingest', payload: {} }]);
    const controller = new AbortController();
    const request = new Request('http://localhost/api/ingestion/session_enqfail/events', {
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_enqfail' });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // consume the replay frame; subscribe() has now registered
    expect(subscribe).toHaveBeenCalledOnce();

    // The live handler the route registered (subscribe(table, id, handler)).
    const liveHandler = subscribe.mock.calls[0][2] as (n: { event_id: number }) => Promise<void>;

    // Close the stream from the consumer side so the controller's enqueue throws.
    await reader.cancel();

    // A live notification arrives: the handler re-queries then tries to emit, but
    // enqueue now throws on the closed stream. That throw must tear down the
    // subscription via close(), not silently set `closed` and leak the subscriber.
    computeReplay.mockResolvedValueOnce([{ id: 2, event_type: 'ingest', payload: {} }]);
    await liveHandler({ event_id: 2 });

    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('F-dedup overlapping NOTIFY: the live cursor advances with emitted ids so overlapping NOTIFYs do not re-send frames', async () => {
    // Regression (PR #959 round-4): the live callback must use
    // Math.max(lastEmittedId, event_id - 1) as the replay cursor. With a bare
    // `event_id - 1`, a stale/overlapping NOTIFY re-queries below the high-water
    // mark and re-emits already-sent frames.
    computeReplay.mockResolvedValueOnce([{ id: 5, event_type: 'ingest', payload: {} }]);
    const controller = new AbortController();
    const request = new Request('http://localhost/api/ingestion/session_dedup/events', {
      signal: controller.signal,
    });

    const response = await GET(request, { id: 'session_dedup' });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // consume replay frame → lastEmittedId = 5, subscribe registered
    const liveHandler = subscribe.mock.calls[0][2] as (n: { event_id: number }) => Promise<void>;

    // NOTIFY(7): a concurrent write also produced 6. Cursor = max(5, 7-1) = 6.
    computeReplay.mockResolvedValueOnce([
      { id: 6, event_type: 'ingest', payload: {} },
      { id: 7, event_type: 'ingest', payload: {} },
    ]);
    await liveHandler({ event_id: 7 });
    expect(computeReplay).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ lastEventId: 6 }),
    );

    // Overlapping/stale NOTIFY(6) arrives after 6 and 7 were already emitted. A
    // bare event_id-1 would query lastEventId=5 and re-fetch 6,7; the dedup cursor
    // uses max(lastEmittedId=7, 5) = 7, so nothing already-sent is re-queried.
    computeReplay.mockResolvedValueOnce([]);
    await liveHandler({ event_id: 6 });
    expect(computeReplay).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ lastEventId: 7 }),
    );

    controller.abort();
    await reader.cancel().catch(() => {});
  });
});
