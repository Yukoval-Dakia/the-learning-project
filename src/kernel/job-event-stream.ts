import type { Db } from '@/db/client';
import { computeReplay } from '@/kernel/job-events';
import {
  INTERACTIVE_ARTIFACT_TOOL_NAMES,
  redactInteractiveArtifactToolInput,
} from '@/kernel/learning-content';

// Process-local pub/sub and complete SSE responses for job-event channels.
// The listen loop parses NOTIFY and fans out here. Only the app process
// subscribes; the worker does not consume its own notifications.

export type SSEPayload = {
  event_id: number;
  business_table: string;
  business_id: string;
};

export type SSEHandler = (payload: SSEPayload) => void;

/**
 * Live frames carry their content inside the NOTIFY payload (no event_id, no
 * replay). They are emitted on the same SSE response as data-only frames and
 * reach only clients already subscribed to this exact business channel.
 */
export type SSELivePayload = {
  business_table: string;
  business_id: string;
  event_type: string;
  payload: Record<string, unknown>;
};

export type SSELiveHandler = (payload: SSELivePayload) => void;

const subscribers: Map<string, Set<SSEHandler>> = new Map();
const liveSubscribers: Map<string, Set<SSELiveHandler>> = new Map();

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

export function subscribeLive(
  businessTable: string,
  businessId: string,
  handler: SSELiveHandler,
): () => void {
  const key = channelKey(businessTable, businessId);
  let set = liveSubscribers.get(key);
  if (!set) {
    set = new Set();
    liveSubscribers.set(key, set);
  }
  set.add(handler);
  return () => {
    const current = liveSubscribers.get(key);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) liveSubscribers.delete(key);
  };
}

export function broadcastLive(payload: SSELivePayload): void {
  const set = liveSubscribers.get(channelKey(payload.business_table, payload.business_id));
  if (!set) return;
  for (const h of set) {
    try {
      h(payload);
    } catch (err) {
      console.error('[sse_router] live handler error', err);
    }
  }
}

/** SSE comment cadence: below the client's transport-idle watchdog. */
const JOB_EVENT_HEARTBEAT_MS = 15_000;
/** Durable cursor catch-up: NOTIFY is a wake-up hint, never the only delivery path. */
const JOB_EVENT_CATCHUP_MS = 10_000;

/**
 * YUK-1763 — persisted job-event frames carry the artifact-authoring tools'
 * FULL args (html with answer attributes + the answer manifest). Frames written
 * before the serve-time redaction stay raw in storage, so every emitted frame
 * is redacted here; write-time redaction (tool-activity.ts) makes this a no-op
 * for new frames.
 */
function redactJobEventPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  if (
    typeof record.tool_name !== 'string' ||
    !INTERACTIVE_ARTIFACT_TOOL_NAMES.has(record.tool_name)
  ) {
    return record;
  }
  const input = record.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return record;
  return {
    ...record,
    input: redactInteractiveArtifactToolInput(input as Record<string, unknown>),
  };
}

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
      let unsubLive: (() => void) | undefined;
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
        unsubLive?.();
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
            payload: redactJobEventPayload(event.payload),
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
                  payload: redactJobEventPayload(event.payload),
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
                payload: redactJobEventPayload(event.payload),
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
        // Live frames are data-only (no id: line): they never advance the durable
        // cursor, so reconnect replay neither duplicates nor recovers them.
        unsubLive = subscribeLive(businessTable, businessId, (live) => {
          emitSseFrame(
            `data: ${JSON.stringify({ event_type: live.event_type, payload: live.payload })}\n\n`,
          );
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
