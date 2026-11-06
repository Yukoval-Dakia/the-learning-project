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

import { sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event as eventTable, job_events } from '@/db/schema';
import { COPILOT_REPLY_ACTION } from '@/kernel/events/copilot-actions';
import { JOB_LIVE_NOTIFY_CHANNEL } from '@/kernel/job-events';
import { COPILOT_RUN_THINKING_EVENT } from '../thinking-lane-contract';
import { COPILOT_RUN_EVENTS, COPILOT_RUN_TABLE } from './copilot-run-status';

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
// Defensive duplicate of the writer's 6000-byte envelope budget: pg_notify
// rejects payloads near 8000 bytes.
const NOTIFY_PAYLOAD_BUDGET_BYTES = 7000;
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
  let publishFailureWarned = false;
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

  // Terminal check and send are one statement: a frame queued behind a Stop or
  // terminal frame cannot notify after the fact, and one pool statement per
  // frame replaces the prior two SELECTs + NOTIFY. The notification string
  // (which embeds the thinking text) is a bound parameter; no text is inlined
  // into SQL, so PostgreSQL's statement/error logs never carry the content.
  const publishGuarded = async (frame: {
    business_table: string;
    business_id: string;
    event_type: string;
    payload: Record<string, unknown>;
  }): Promise<boolean> => {
    const notification = JSON.stringify(frame);
    if (Buffer.byteLength(notification, 'utf8') > NOTIFY_PAYLOAD_BUDGET_BYTES) {
      return false;
    }
    const rows = await deps.db.execute(sql`
      SELECT pg_notify(${JOB_LIVE_NOTIFY_CHANNEL}, ${notification})
      WHERE NOT EXISTS (
        SELECT 1 FROM ${job_events}
        WHERE ${job_events.business_table} = ${COPILOT_RUN_TABLE}
          AND ${job_events.business_id} = ${deps.runId}
          AND (
            ${job_events.event_type} = ${COPILOT_RUN_EVENTS.CANCEL_REQUESTED}
            OR ${job_events.event_type} = ${COPILOT_RUN_EVENTS.DONE}
            OR (
              ${job_events.event_type} = ${COPILOT_RUN_EVENTS.FAILED}
              AND coalesce(${job_events.payload}->>'reason', '') <> 'error'
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${eventTable}
        WHERE ${eventTable.action} = ${COPILOT_REPLY_ACTION}
          AND ${eventTable.caused_by_event_id} = ${deps.runId}
          AND ${eventTable.outcome} IN ('success', 'failure')
      )
    `);
    return rows.length > 0;
  };

  // Terminal states are irreversible: once the guarded statement reports them,
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
        if (disposed || laneClosed) {
          framesDropped += 1;
          return;
        }
        const notified = await publishGuarded(frame);
        if (!notified) {
          laneClosed = true;
          framesDropped += 1;
          return;
        }
        framesSent += 1;
        bytesSent += utf8.encode(text).byteLength;
      })
      // A probe/publish throw must terminate here: an unhandled rejection would
      // hit the worker's supervised-restart handler and kill unrelated runs.
      .catch(() => {
        framesDropped += 1;
        if (!publishFailureWarned) {
          publishFailureWarned = true;
          console.warn('[copilot-live] thinking publish failed; dropping frame', {
            run_id: deps.runId,
          });
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

  // true = chain settled within the bound; false = bound hit.
  const waitForChain = (ms: number): Promise<boolean> =>
    Promise.race([
      chain.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        timer.unref?.();
      }),
    ]);

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
        // Consume a seq so the client sees a gap, not silently missing text.
        seq += 1;
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
      const deadline = Date.now() + LIVE_DRAIN_MAX_WAIT_MS;
      let timedOut = false;
      // Drain in 4-frame batches: a full tail must not enqueue a 64-frame burst.
      while (buffered.length > 0 && !laneClosed && !disposed) {
        flush(LIVE_MAX_FRAMES_PER_FLUSH);
        clearFlushTimer();
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !(await waitForChain(remaining))) {
          timedOut = true;
          break;
        }
      }
      if (pendingFrames > 0) {
        const remaining = Math.max(0, deadline - Date.now());
        if (remaining === 0 || !(await waitForChain(remaining))) {
          timedOut = true;
        }
      }
      if (timedOut) {
        if (buffered.length > 0) seq += 1;
        buffered = '';
        laneClosed = true;
        console.warn('[copilot-live] thinking drain timed out; live lane abandoned', {
          run_id: deps.runId,
        });
      } else if (laneClosed) {
        // Terminal/cancel landed while draining; a late tail must not notify.
        if (buffered.length > 0) seq += 1;
        buffered = '';
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
