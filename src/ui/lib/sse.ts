'use client';

// Phase 1c.2 Vision MVP — SSE consumer hook.
//
// The browser-native EventSource can't carry custom headers, so we'd lose the
// x-internal-token middleware gate. fetch() + ReadableStream gives us a typed
// SSE consumer with the same header story as apiFetch.
//
// Mirrors the wire shape emitted by /api/ingestion/[id]/events:
//   id: <num>\ndata: { event_id, event_type, payload }\n\n

import { useEffect, useRef, useState } from 'react';
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

export function useIngestionSSE(sessionId: string | null): UseIngestionSSEResult {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [status, setStatus] = useState<SSEStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (!sessionId) {
      setStatus('idle');
      setEvents([]);
      return;
    }
    setEvents([]);
    setStatus('connecting');
    setError(null);
    cancelledRef.current = false;
    const ac = new AbortController();

    (async () => {
      try {
        const token = getInternalToken();
        if (!token) throw new ApiAuthError('未设置 internal token');
        const res = await fetch(`/api/ingestion/${sessionId}/events`, {
          method: 'GET',
          headers: { 'x-internal-token': token, accept: 'text/event-stream' },
          signal: ac.signal,
          cache: 'no-store',
        });
        if (res.status === 401) {
          clearInternalToken();
          throw new ApiAuthError('token 无效或已过期');
        }
        if (!res.ok) throw new Error(`SSE init failed: ${res.status} ${res.statusText}`);
        if (!res.body) throw new Error('SSE response missing body');

        setStatus('open');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamError: Error | null = null;

        while (!cancelledRef.current) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf('\n\n');
          while (sep !== -1) {
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (isSseErrorFrame(chunk)) {
              // Server-side stream failure: the route emits a named `event: error`
              // frame then closes. parseSSEChunk drops it (no numeric event_id), so
              // without this branch EOF lands on 'closed' and the consumer can't
              // tell a healthy finish from a mid-stream DB/connection error —
              // recovery branches (e.g. VisionTab) would then hang on 'extracting'.
              streamError = new Error('录入进度连接中断');
            } else {
              const ev = parseSSEChunk(chunk);
              if (ev) setEvents((prev) => [...prev, ev]);
            }
            sep = buffer.indexOf('\n\n');
          }
          if (streamError) break;
        }
        if (!cancelledRef.current) {
          if (streamError) {
            setError(streamError);
            setStatus('error');
          } else {
            setStatus('closed');
          }
        }
      } catch (err) {
        if (cancelledRef.current) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setError(err as Error);
        setStatus('error');
      }
    })();

    return () => {
      cancelledRef.current = true;
      ac.abort();
    };
  }, [sessionId]);

  return { events, status, error };
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
