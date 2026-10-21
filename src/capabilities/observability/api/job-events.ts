import { db } from '@/db/client';
import { computeReplay } from '@/server/events/sse_replay';
import { subscribe } from '@/server/events/sse_router';
import { JOB_EVENT_KIND_SET } from './event-contracts';

/** SSE comment cadence: below the client's transport-idle watchdog. */
export const JOB_EVENT_HEARTBEAT_MS = 15_000;
/** Durable cursor catch-up: NOTIFY is a wake-up hint, never the only delivery path. */
export const JOB_EVENT_CATCHUP_MS = 10_000;

// Generic SSE tracker for job_events, keyed by business kind and id. Any domain
// writing job events can use it; Last-Event-ID drives replay, then live events come
// from the router. Abort unsubscribes and closes the stream.
//
// `kind` comes from the caller, so an allowlist is required: otherwise any
// authenticated caller could subscribe to any business table. Add new writers here
// or their stream gets a 400.
export async function GET(req: Request, params: Record<string, string>): Promise<Response> {
  const businessTable = params.kind;
  const businessId = params.id;

  if (!businessTable || !businessId) {
    return new Response(JSON.stringify({ error: 'missing kind or id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!JOB_EVENT_KIND_SET.has(businessTable)) {
    return new Response(JSON.stringify({ error: 'unknown kind' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const lastEventIdHeader = req.headers.get('Last-Event-ID');
  // A non-numeric header would put NaN into the id comparison; treat it as full replay.
  const parsed = lastEventIdHeader ? Number.parseInt(lastEventIdHeader, 10) : 0;
  const lastEventId = Number.isNaN(parsed) ? 0 : parsed;

  const encoder = new TextEncoder();

  let stopStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unsub: (() => void) | undefined;
      // Track the largest emitted id. Replay work is serialized below and every
      // enqueue is idempotent against this cursor.
      let lastEmittedId = lastEventId;
      let replayQueue: Promise<void> = Promise.resolve();
      let catchup: ReturnType<typeof setInterval> | undefined;
      let periodicCatchupPending = false;

      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        if (catchup) clearInterval(catchup);
        req.signal.removeEventListener('abort', close);
        // Cleanup converges here for normal abort and error paths.
        unsub?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      stopStream = close;

      const emitHeartbeat = () => {
        if (closed) return;
        try {
          // SSE comments are transport activity, not business events: they do
          // not advance Last-Event-ID or enter the Copilot fold.
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          close();
        }
      };
      const heartbeat = setInterval(emitHeartbeat, JOB_EVENT_HEARTBEAT_MS);

      const emit = (id: number, data: unknown) => {
        if (closed || id <= lastEmittedId) return;
        const payload = `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
          if (id > lastEmittedId) lastEmittedId = id;
        } catch {
          close();
        }
      };

      // Register abort before any await, so a disconnect during replay still cleans up.
      req.signal.addEventListener('abort', close);

      if (req.signal.aborted) {
        close();
        return;
      }

      try {
        const replay = await computeReplay(db, {
          businessTable,
          businessId,
          lastEventId,
        });
        // The request may have been aborted while the replay query was in
        // flight. Do not install a live subscription after close() has already
        // run, otherwise an unmounted client leaves an unreachable subscriber.
        if (closed) return;
        for (const event of replay) {
          emit(event.id, {
            event_id: event.id,
            event_type: event.event_type,
            payload: event.payload,
          });
        }
        if (closed) return;

        // An event can land between the replay snapshot and subscription. Install
        // first, then serialize catch-up before live notifications; id dedupe keeps
        // order and closes the gap without loss.
        const enqueueReplay = (): Promise<void> => {
          replayQueue = replayQueue.then(async () => {
            if (closed) return;
            const incoming = await computeReplay(db, {
              businessTable,
              businessId,
              lastEventId: lastEmittedId,
            });
            if (closed) return;
            for (const event of incoming) {
              emit(event.id, {
                event_id: event.id,
                event_type: event.event_type,
                payload: event.payload,
              });
            }
          });
          return replayQueue;
        };

        unsub = subscribe(businessTable, businessId, () => {
          void enqueueReplay().catch(() => {
            emitError();
            close();
          });
        });
        // LISTEN/NOTIFY can miss events across a reconnect while the socket stays
        // healthy, so also poll from the durable cursor. Same serialized queue.
        catchup = setInterval(() => {
          if (periodicCatchupPending || closed) return;
          periodicCatchupPending = true;
          void enqueueReplay()
            .catch(() => {
              emitError();
              close();
            })
            .finally(() => {
              periodicCatchupPending = false;
            });
        }, JOB_EVENT_CATCHUP_MS);
        await enqueueReplay();
      } catch {
        // Initial replay/subscribe failure: tell the client and close, rather than
        // leaving a silent stream open forever.
        emitError();
        close();
      }

      function emitError() {
        if (closed) return;
        const payload = 'event: error\ndata: {"error":"stream_failed"}\n\n';
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // already closed / errored
        }
      }
    },
    cancel() {
      stopStream();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
