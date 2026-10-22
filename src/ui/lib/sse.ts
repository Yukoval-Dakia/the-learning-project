'use client';

// Phase 1c.2 Vision MVP — SSE consumer hook.
//
// The browser-native EventSource can't carry custom headers, so we'd lose the
// x-internal-token middleware gate. fetch() + ReadableStream gives us a typed
// SSE consumer with the same header story as apiFetch.
//
// Mirrors the wire shape emitted by /api/ingestion/[id]/events:
//   id: <num>\ndata: { event_id, event_type, payload }\n\n

import { useCallback, useSyncExternalStore } from 'react';
import { ApiAuthError, clearInternalToken, getInternalToken } from './api';

export interface SSEEvent {
  event_id: number;
  event_type: string;
  payload: Record<string, unknown>;
}

export type SSEStatus = 'idle' | 'connecting' | 'open' | 'error' | 'closed';

export interface UseIngestionSSEResult {
  events: SSEEvent[];
  status: SSEStatus;
  error: Error | null;
}

// YUK-1483 — session-keyed stream owner, read through useSyncExternalStore.
//
// Each ingestion session id owns ONE connection generation: its own
// AbortController, reader and cached snapshot. The first subscriber to a session
// opens the stream; when the last subscriber leaves, the generation is disposed
// (abort + reader cancel/releaseLock). Late frames of a disposed generation can
// only touch that generation's own snapshot, which nobody reads any more, so a
// switch from session A to B never mixes A's events into B. While anyone is
// subscribed to a session, its finished snapshot (closed or error) stays readable —
// that is what keeps OnboardRecord's page counts visible in its done state.
//
// `streams` is only written from `subscribe`, which React never calls during
// server rendering, so no per-user stream state is created on the server.
const IDLE: UseIngestionSSEResult = { events: [], status: 'idle', error: null };
const CONNECTING: UseIngestionSSEResult = { events: [], status: 'connecting', error: null };

interface SessionStream {
  snapshot: UseIngestionSSEResult;
  listeners: Set<() => void>;
  abort: AbortController;
  disposed: boolean;
}

const streams = new Map<string, SessionStream>();

function publish(stream: SessionStream, next: Partial<UseIngestionSSEResult>) {
  if (stream.disposed) return;
  stream.snapshot = { ...stream.snapshot, ...next };
  for (const listener of stream.listeners) listener();
}

async function readStream(sessionId: string, stream: SessionStream): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const token = getInternalToken();
    if (!token) throw new ApiAuthError('未设置 internal token');
    const res = await fetch(`/api/ingestion/${sessionId}/events`, {
      method: 'GET',
      headers: { 'x-internal-token': token, accept: 'text/event-stream' },
      signal: stream.abort.signal,
      cache: 'no-store',
    });
    if (res.status === 401) {
      clearInternalToken();
      throw new ApiAuthError('token 无效或已过期');
    }
    if (!res.ok) throw new Error(`SSE init failed: ${res.status} ${res.statusText}`);
    if (!res.body) throw new Error('SSE response missing body');

    publish(stream, { status: 'open' });
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let streamError: Error | null = null;

    while (!stream.disposed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const batch: SSEEvent[] = [];
      let sep = buffer.indexOf('\n\n');
      while (sep !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (isSseErrorFrame(chunk)) {
          // Server-side stream failure: the route emits a named `event: error`
          // frame then closes. parseSSEChunk drops it (no numeric event_id), so
          // without this branch EOF lands on 'closed' and the consumer can't
          // tell a healthy finish from a mid-stream DB/connection error —
          // a reopened recording would then hang on 'extracting'.
          streamError = new Error('录入进度连接中断');
        } else {
          const ev = parseSSEChunk(chunk);
          if (ev) batch.push(ev);
        }
        sep = buffer.indexOf('\n\n');
      }
      if (batch.length > 0) publish(stream, { events: [...stream.snapshot.events, ...batch] });
      if (streamError) break;
    }
    if (streamError) publish(stream, { error: streamError, status: 'error' });
    else publish(stream, { status: 'closed' });
  } catch (err) {
    if (stream.disposed) return;
    if (err instanceof Error && err.name === 'AbortError') return;
    publish(stream, { error: err as Error, status: 'error' });
  } finally {
    if (reader) {
      // Disposed mid-read: cancel the body so the connection is released, then
      // drop the lock either way. Both are best-effort on an aborted stream.
      if (stream.disposed) reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        // Older engines refuse releaseLock while a read is pending; abort ended it.
      }
    }
  }
}

function subscribeSession(sessionId: string, listener: () => void): () => void {
  let stream = streams.get(sessionId);
  if (!stream) {
    stream = {
      snapshot: CONNECTING,
      listeners: new Set(),
      abort: new AbortController(),
      disposed: false,
    };
    streams.set(sessionId, stream);
    void readStream(sessionId, stream);
  }
  const owned = stream;
  owned.listeners.add(listener);
  return () => {
    owned.listeners.delete(listener);
    if (owned.listeners.size > 0) return;
    // Wait one microtask so a StrictMode / same-commit resubscribe to the same
    // session keeps this generation instead of reconnecting.
    queueMicrotask(() => {
      if (owned.listeners.size > 0 || owned.disposed) return;
      owned.disposed = true;
      owned.abort.abort();
      if (streams.get(sessionId) === owned) streams.delete(sessionId);
    });
  };
}

function readSnapshot(sessionId: string | null): UseIngestionSSEResult {
  if (!sessionId) return IDLE;
  return streams.get(sessionId)?.snapshot ?? CONNECTING;
}

const noopUnsubscribe = () => {};

export function useIngestionSSE(sessionId: string | null): UseIngestionSSEResult {
  const subscribe = useCallback(
    (listener: () => void) => (sessionId ? subscribeSession(sessionId, listener) : noopUnsubscribe),
    [sessionId],
  );
  const getSnapshot = () => readSnapshot(sessionId);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Recognize the server's named error frame: `event: error\ndata: {...}`.
 *
 * Both SSE routes (ingestion/api/events.ts and observability/api/job-events.ts)
 * emit this exact shape when the stream fails mid-flight (DB/connection error),
 * then close. parseSSEChunk ignores it (no numeric event_id), so consumers must
 * detect it explicitly to distinguish a failure from a healthy EOF. Exported so
 * a future job-events client consumer can reuse it and keep both SSE paths'
 * error handling consistent.
 */
export function isSseErrorFrame(chunk: string): boolean {
  for (const line of chunk.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('event:')) {
      return trimmed.slice('event:'.length).trim() === 'error';
    }
  }
  return false;
}

function parseSSEChunk(chunk: string): SSEEvent | null {
  let dataLine: string | null = null;
  for (const line of chunk.split('\n')) {
    if (line.startsWith('data:')) {
      dataLine = line.slice(5).trim();
      // SSE allows a single event to span multiple `data:` lines — we only
      // emit one, which matches the server's single-line payload format.
      break;
    }
  }
  if (dataLine === null) return null;
  try {
    const parsed = JSON.parse(dataLine) as {
      event_id?: number;
      event_type?: string;
      payload?: Record<string, unknown>;
    };
    if (typeof parsed.event_id !== 'number' || typeof parsed.event_type !== 'string') {
      return null;
    }
    return {
      event_id: parsed.event_id,
      event_type: parsed.event_type,
      payload: parsed.payload ?? {},
    };
  } catch {
    return null;
  }
}
