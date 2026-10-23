import type { Db } from '@/db/client';
import { computeReplay } from './sse_replay';

// Process-local pub/sub and complete SSE responses for job-event channels.
// The listen loop parses NOTIFY and fans out here. Only the app process
// subscribes; the worker does not consume its own notifications.

export type SSEPayload = {
  event_id: number;
  business_table: string;
  business_id: string;
};

export type SSEHandler = (payload: SSEPayload) => void;

const subscribers: Map<string, Set<SSEHandler>> = new Map();

function channelKey(businessTable: string, businessId: string): string {
  return `${businessTable}:${businessId}`;
}

export function subscribe(
  businessTable: string,
  businessId: string,
  handler: SSEHandler,
): () => void {
  const key = channelKey(businessTable, businessId);
  let set = subscribers.get(key);
  if (!set) {
    set = new Set();
    subscribers.set(key, set);
  }
  set.add(handler);
  return () => unsubscribe(businessTable, businessId, handler);
}

export function unsubscribe(businessTable: string, businessId: string, handler: SSEHandler): void {
  const key = channelKey(businessTable, businessId);
  const set = subscribers.get(key);
  if (!set) return;
  set.delete(handler);
  if (set.size === 0) subscribers.delete(key);
}

export function broadcast(payload: SSEPayload): void {
  const key = channelKey(payload.business_table, payload.business_id);
  const set = subscribers.get(key);
  if (!set) return;
  for (const h of set) {
    try {
      h(payload);
    } catch (err) {
      // One failing subscriber must not skip the rest.
      console.error('[sse_router] handler error', err);
    }
  }
}

/** SSE comment cadence: below the client's transport-idle watchdog. */
const JOB_EVENT_HEARTBEAT_MS = 15_000;
/** Durable cursor catch-up: NOTIFY is a wake-up hint, never the only delivery path. */
const JOB_EVENT_CATCHUP_MS = 10_000;

/**
 * Own replay, live delivery and response cleanup for the two existing protocols.
 * Job trackers serialize durable catch-up and send heartbeats. Ingestion keeps
 * its notification cursor and concurrent callbacks, without timers or cancel hook.
 */
export function jobEventStreamResponse(
  db: Db,
  req: Request,
  { businessTable, businessId }: { businessTable: string; businessId: string },
  profile: 'job-tracker' | 'ingestion-notify',
): Response {
  const lastEventIdHeader = req.headers.get('Last-Event-ID');
  // Preserve parseInt's numeric-prefix/negative cursor behavior; only NaN resets.
  const parsed = lastEventIdHeader ? Number.parseInt(lastEventIdHeader, 10) : 0;
  const lastEventId = Number.isNaN(parsed) ? 0 : parsed;
  const encoder = new TextEncoder();

  let stopStream = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unsub: (() => void) | undefined;
      let lastEmittedId = lastEventId;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let catchup: ReturnType<typeof setInterval> | undefined;

      const close = () => {
        if (closed) return;
        closed = true;
        if (profile === 'job-tracker') {
          if (heartbeat !== undefined) clearInterval(heartbeat);
          if (catchup) clearInterval(catchup);
          req.signal.removeEventListener('abort', close);
        }
        unsub?.();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      stopStream = close;

      // A failed enqueue must clean up the subscription before close becomes a
      // no-op. Both data frames and ingestion error frames use this operation.
      const emitSseFrame = (frame: string): boolean => {
        if (closed) return false;
        try {
          controller.enqueue(encoder.encode(frame));
          return true;
        } catch {
          close();
          return false;
        }
      };

      if (profile === 'job-tracker') {
        // Establish heartbeat before the initial query. Comments prove transport
        // activity only: they never advance the durable business-event cursor.
        heartbeat = setInterval(() => {
          emitSseFrame(': keepalive\n\n');
        }, JOB_EVENT_HEARTBEAT_MS);
      }

      const emit = (id: number, data: unknown) => {
        // Ingestion deliberately has no emit-level id suppression: overlapping
        // notification callbacks retain their existing delivery semantics.
        if (profile === 'job-tracker' && (closed || id <= lastEmittedId)) return;
        if (emitSseFrame(`id: ${id}\ndata: ${JSON.stringify(data)}\n\n`) && id > lastEmittedId) {
          lastEmittedId = id;
        }
      };

      const emitError = () => {
        const frame = 'event: error\ndata: {"error":"stream_failed"}\n\n';
        if (profile === 'ingestion-notify') {
          emitSseFrame(frame);
          return;
        }
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          // Tracker error handling closes explicitly after attempting the frame.
        }
      };

      // Register before any await so abort during initial replay closes the
      // response. A request already aborted must not query or subscribe.
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
        if (profile === 'job-tracker' && closed) return;
        for (const event of replay) {
          emit(event.id, {
            event_id: event.id,
            event_type: event.event_type,
            payload: event.payload,
          });
        }
        // Never install an unreachable subscription after abort or failed enqueue.
        if (closed) return;

        if (profile === 'ingestion-notify') {
          unsub = subscribe(businessTable, businessId, async (notification) => {
            try {
              const incoming = await computeReplay(db, {
                businessTable,
                businessId,
                lastEventId: Math.max(lastEmittedId, notification.event_id - 1),
              });
              for (const event of incoming) {
                emit(event.id, {
                  event_id: event.id,
                  event_type: event.event_type,
                  payload: event.payload,
                });
              }
            } catch (err) {
              // Keep the existing businessId + err log; never log event payloads.
              console.error('[ingestion:sse] live replay failed', businessId, err);
              emitError();
              close();
            }
          });
          return;
        }

        // Serialize tracker replays and read the cursor when each query starts.
        // Subscribe before the first catch-up to cover the initial SELECT gap.
        let replayQueue: Promise<void> = Promise.resolve();
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
        // A healthy HTTP connection can outlive a lost LISTEN notification.
        // Keep only one periodic replay pending in the same serialized queue.
        let periodicCatchupPending = false;
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
      } catch (err) {
        if (profile === 'ingestion-notify') {
          console.error('[ingestion:sse] initial replay failed', businessId, err);
        }
        emitError();
        close();
      }
    },
    ...(profile === 'job-tracker'
      ? {
          cancel() {
            stopStream();
          },
        }
      : {}),
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
