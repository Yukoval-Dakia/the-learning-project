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

        while (!cancelledRef.current) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep = buffer.indexOf('\n\n');
          while (sep !== -1) {
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const ev = parseSSEChunk(chunk);
            if (ev) setEvents((prev) => [...prev, ev]);
            sep = buffer.indexOf('\n\n');
          }
        }
        if (!cancelledRef.current) setStatus('closed');
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
