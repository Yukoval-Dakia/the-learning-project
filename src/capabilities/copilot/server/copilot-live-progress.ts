// YUK-1909 — display-only live lane for copilot_run thinking. Reasoning text
// rides pg_notify payloads to this run's already-authorized SSE clients and is
// never written to job_events or any other durable sink: on reconnect nothing
// is replayed (the durable thinking_end step states whether an attempt streamed
// reasoning at all), and dropped frames surface as seq gaps the UI tolerates.
//
// Delivery is coalesced like prose (150ms tick) but bounded by the pg_notify
// ~8000-byte payload ceiling: each frame's serialized envelope stays under
// NOTIFY_ENVELOPE_BUDGET_BYTES, split at UTF-8-safe boundaries so a client that
// concatenates payload.text over a contiguous seq range gets byte-identical
// text. At most LIVE_MAX_FRAMES_PER_FLUSH frames leave per tick — a sustained
// cap of ~27 notifies/sec/attempt on the shared notify queue. A publish failure
// drops that frame only; it can never fail the run or its settlement.

import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { job_events } from '@/db/schema';
import { publishJobLiveEvent } from '@/kernel/job-events';
import { findPersistedDurableReply } from './copilot-run-outcome';
import {
  COPILOT_RUN_EVENTS,
  COPILOT_RUN_TABLE,
  hasCancelRequest,
  isCopilotRunTerminalEvent,
} from './copilot-run-status';

export const COPILOT_RUN_LIVE_THINKING_EVENT = 'copilot_run.thinking';

const LIVE_FLUSH_MS = 150;
const LIVE_MAX_FRAMES_PER_FLUSH = 4;
// First-pass split target; the serialized envelope (table/id keys + event_type +
// escaped JSON text) is then verified against the notify budget and halved until
// it fits — escaping can inflate bytes well beyond the raw text length.
const LIVE_FRAME_TEXT_BYTES = 4096;
const NOTIFY_ENVELOPE_BUDGET_BYTES = 6000;
// Crash-lane bound: a stalled DB or dead listener must not grow memory. Content
// past the cap is dropped once per run (seq gap), never persisted elsewhere.
const LIVE_BUFFER_MAX_BYTES = 256 * 1024;

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
  // seq is strictly increasing per (run, attempt task_run_id); a new attempt
  // flushes any pending tail of the previous one before restarting at 1.
  let currentTaskRunId: string | undefined;
  let seq = 0;
  let framesEmitted = 0;
  let bytesEmitted = 0;

  const envelope = (taskRunId: string, frameSeq: number, text: string) => ({
    business_table: COPILOT_RUN_TABLE,
    business_id: deps.runId,
    event_type: COPILOT_RUN_LIVE_THINKING_EVENT,
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
    return !(await findPersistedDurableReply(deps.db, deps.runId));
  };

  // Terminal states are irreversible: once the boundary probe closes the lane,
  // later frames skip the probe entirely instead of re-checking a settled run.
  let laneClosed = false;
  const enqueueFrame = (text: string) => {
    if (currentTaskRunId === undefined) return;
    const frame = envelope(currentTaskRunId, seq, text);
    chain = chain
      .catch(() => undefined)
      .then(async () => {
        if (laneClosed) return;
        if (!(await laneOpen())) {
          laneClosed = true;
          return;
        }
        await publishJobLiveEvent(deps.db, frame);
      });
  };

  const flush = (frameCap = LIVE_MAX_FRAMES_PER_FLUSH) => {
    let emitted = 0;
    while (buffered.length > 0 && emitted < frameCap && !disposed) {
      const head = fitFrameText(buffered);
      if (head.length === 0) return; // nothing fits; bail rather than emit an empty frame
      buffered = buffered.slice(head.length);
      seq += 1;
      framesEmitted += 1;
      bytesEmitted += utf8.encode(head).byteLength;
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
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, LIVE_FLUSH_MS);
    timer.unref?.();
  };

  return {
    pushThinking(delta) {
      if (disposed || delta.text.length === 0) return;
      if (delta.taskRunId !== currentTaskRunId) {
        flush();
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
      if (utf8.encode(buffered).byteLength >= LIVE_FRAME_TEXT_BYTES) flush();
      else scheduleFlush();
    },
    async drain() {
      clearFlushTimer();
      flush(Number.POSITIVE_INFINITY);
      await chain;
    },
    dispose() {
      disposed = true;
      clearFlushTimer();
      buffered = '';
      console.log('[copilot-live] thinking lane closed', {
        run_id: deps.runId,
        frames: framesEmitted,
        bytes: bytesEmitted,
      });
    },
  };
}
