// YUK-1909 — display-only live lane for copilot_run thinking. Reasoning text
// rides pg_notify payloads to this run's already-authorized SSE clients and is
// never written to job_events or any other durable sink: on reconnect nothing
// is replayed (the durable thinking_end step states whether an attempt streamed
// reasoning at all), and dropped frames surface as seq gaps the UI tolerates.
//
// Delivery is coalesced: one flush per 150ms window, at most 4 frames per flush
// (a sustained ceiling of ~27 notifications/sec/attempt) and each serialized
// envelope stays under NOTIFY_ENVELOPE_BUDGET_BYTES, split at UTF-8-safe
// boundaries so a client that concatenates payload.text over a contiguous seq
// range gets byte-identical text. When the publish chain backs up, frames past
// LIVE_PENDING_FRAMES_MAX are dropped instead of growing memory. A publish
// failure drops that frame only; it can never fail the run or its settlement.

import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event, job_events } from '@/db/schema';
import { COPILOT_REPLY_ACTION } from '@/kernel/events/copilot-actions';
import { publishJobLiveEvent } from '@/kernel/job-events';
import { COPILOT_RUN_THINKING_EVENT } from '../thinking-lane-contract';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  hasCancelRequest,
  isCopilotRunTerminalEvent,
} from './copilot-run-status';

const LIVE_FLUSH_MS = 150;
const LIVE_MAX_FRAMES_PER_FLUSH = 4;
// First-pass split target; the serialized envelope (table/id keys + event_type +
// escaped JSON text) is then verified against the notify budget and halved until
// it fits — escaping can inflate bytes well beyond the raw text length.
const LIVE_FRAME_TEXT_BYTES = 4096;
const NOTIFY_ENVELOPE_BUDGET_BYTES = 6000;
// Crash-lane bound: a stalled DB or dead listener must not grow memory. Content
// past the cap is dropped (seq gap), never persisted elsewhere.
const LIVE_BUFFER_MAX_BYTES = 256 * 1024;
// Frames already sliced out of the buffer but not yet published.
const LIVE_PENDING_FRAMES_MAX = 64;
// A display-only drain must never hold the reply or settlement behind a slow DB.
const LIVE_DRAIN_MAX_WAIT_MS = 500;

const utf8 = new TextEncoder();

/** Longest code-point-aligned prefix whose UTF-8 length fits `maxBytes`. */
function takeUtf8Prefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let index = 0;
  for (const ch of text) {
    const size = utf8.encode(ch).byteLength;
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += ch.length;
  }
  return text.slice(0, index);
}

export interface CopilotRunLiveWriter {
  pushThinking(delta: { taskRunId: string; text: string }): void;
  /** Emit everything still buffered, then settle the serialized publish chain. */
  drain(): Promise<void>;
  /** Cancel the timer and drop the buffer (cancel/terminal boundary). */
  dispose(): void;
}

export function createCopilotRunLiveWriter(deps: { db: Db; runId: string }): CopilotRunLiveWriter {
  let chain: Promise<void> = Promise.resolve();
  let buffered = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let bufferOverflowWarned = false;
  let pendingOverflowWarned = false;
  // seq is strictly increasing per (run, attempt task_run_id); a new attempt
  // fully flushes the previous one before restarting at 1.
  let currentTaskRunId: string | undefined;
  let seq = 0;
  let lastFlushAt = 0;
  let pendingFrames = 0;
  let framesGenerated = 0;
  let framesSent = 0;
  let framesDropped = 0;
  let bytesSent = 0;

  const envelope = (taskRunId: string, frameSeq: number, text: string) => ({
    business_table: COPILOT_RUN_TABLE,
    business_id: deps.runId,
    event_type: COPILOT_RUN_THINKING_EVENT,
    payload: { task_run_id: taskRunId, seq: frameSeq, text },
  });

  const fitFrameText = (text: string): string => {
    let candidate = takeUtf8Prefix(text, LIVE_FRAME_TEXT_BYTES);
    while (
      candidate.length > 0 &&
      utf8.encode(JSON.stringify(envelope(currentTaskRunId ?? '', seq + 1, candidate))).byteLength >
        NOTIFY_ENVELOPE_BUDGET_BYTES
    ) {
      candidate = takeUtf8Prefix(candidate, Math.max(1, utf8.encode(candidate).byteLength >> 1));
    }
    return candidate;
  };

  // Same interception boundary as persisted progress: a committed cancel,
  // terminal frame, or durable reply closes the lane. Read-only check instead
  // of the settlement lock — the residual race is the ms between probe and
  // notify, accepted for a display-only lane.
  const laneOpen = async (): Promise<boolean> => {
    const blocking = await deps.db
      .select({ event_type: job_events.event_type, payload: job_events.payload })
      .from(job_events)
      .where(
        and(
          eq(job_events.business_table, COPILOT_RUN_TABLE),
          eq(job_events.business_id, deps.runId),
          inArray(job_events.event_type, [
            COPILOT_RUN_EVENTS.CANCEL_REQUESTED,
            COPILOT_RUN_EVENTS.DONE,
            COPILOT_RUN_EVENTS.FAILED,
          ]),
        ),
      );
    if (hasCancelRequest(blocking) || blocking.some(isCopilotRunTerminalEvent)) return false;
    // A recovery delivery may persist the reply before its terminal projection;
    // existence is enough (no prose decode on the per-frame hot path).
    const [reply] = await deps.db
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, COPILOT_REPLY_ACTION),
          eq(event.caused_by_event_id, deps.runId),
          inArray(event.outcome, ['success', 'failure']),
        ),
      )
      .limit(1);
    return reply === undefined;
  };

  // Terminal states are irreversible: once the boundary probe closes the lane,
  // later frames skip the probe entirely instead of re-checking a settled run.
  let laneClosed = false;
  const enqueueFrame = (text: string) => {
    if (currentTaskRunId === undefined) return;
    framesGenerated += 1;
    if (pendingFrames >= LIVE_PENDING_FRAMES_MAX) {
      framesDropped += 1;
      if (!pendingOverflowWarned) {
        pendingOverflowWarned = true;
        console.warn('[copilot-live] thinking publish backlog full; dropping frame', {
          run_id: deps.runId,
        });
      }
      return;
    }
    const frame = envelope(currentTaskRunId, seq, text);
    pendingFrames += 1;
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        if (laneClosed) {
          framesDropped += 1;
          return;
        }
        if (!(await laneOpen())) {
          laneClosed = true;
          framesDropped += 1;
          return;
        }
        const sent = await publishJobLiveEvent(deps.db, frame);
        if (sent) {
          framesSent += 1;
          bytesSent += utf8.encode(text).byteLength;
        } else {
          framesDropped += 1;
        }
      })
      .finally(() => {
        pendingFrames -= 1;
      });
  };

  const flush = (frameCap = LIVE_MAX_FRAMES_PER_FLUSH) => {
    if (buffered.length === 0) return;
    lastFlushAt = Date.now();
    let emitted = 0;
    while (buffered.length > 0 && emitted < frameCap && !disposed) {
      const head = fitFrameText(buffered);
      if (head.length === 0) return; // nothing fits; bail rather than emit an empty frame
      buffered = buffered.slice(head.length);
      seq += 1;
      enqueueFrame(head);
      emitted += 1;
    }
    if (buffered.length > 0 && !disposed) scheduleFlush();
  };

  const clearFlushTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleFlush = () => {
    if (timer || disposed) return;
    const wait = Math.max(0, lastFlushAt + LIVE_FLUSH_MS - Date.now());
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, wait);
    timer.unref?.();
  };

  return {
    pushThinking(delta) {
      if (disposed || delta.text.length === 0) return;
      if (delta.taskRunId !== currentTaskRunId) {
        // The old attempt's whole tail must leave under its own id and seq: a
        // partial flush here would emit the remainder under the next attempt.
        clearFlushTimer();
        flush(Number.POSITIVE_INFINITY);
        currentTaskRunId = delta.taskRunId;
        seq = 0;
      }
      buffered += delta.text;
      if (utf8.encode(buffered).byteLength > LIVE_BUFFER_MAX_BYTES) {
        buffered = '';
        if (!bufferOverflowWarned) {
          bufferOverflowWarned = true;
          console.warn('[copilot-live] thinking buffer overflow; dropping buffered frames', {
            run_id: deps.runId,
          });
        }
        return;
      }
      if (utf8.encode(buffered).byteLength >= LIVE_FRAME_TEXT_BYTES) {
        if (Date.now() - lastFlushAt >= LIVE_FLUSH_MS) flush();
        else scheduleFlush();
      } else {
        scheduleFlush();
      }
    },
    async drain() {
      clearFlushTimer();
      flush(Number.POSITIVE_INFINITY);
      let timedOut = false;
      await Promise.race([
        chain,
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            timedOut = true;
            resolve();
          }, LIVE_DRAIN_MAX_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      if (timedOut) {
        console.warn('[copilot-live] thinking drain timed out; live lane abandoned', {
          run_id: deps.runId,
        });
      }
    },
    dispose() {
      disposed = true;
      clearFlushTimer();
      buffered = '';
      console.log('[copilot-live] thinking lane closed', {
        run_id: deps.runId,
        frames_generated: framesGenerated,
        frames_sent: framesSent,
        frames_dropped: framesDropped,
        bytes_sent: bytesSent,
      });
    },
  };
}
