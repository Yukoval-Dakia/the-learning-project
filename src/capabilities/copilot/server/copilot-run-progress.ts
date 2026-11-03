// Per-run progress writer for durable copilot runs. Provider prose arrives in
// small chunks; persisting each chunk would turn a long reply into hundreds of
// locked transactions. This writer coalesces deltas by time and by size, then
// commits through the same serialized chain that orders STEP frames, so the
// job_events stream keeps its contract: id-ordered, cursor-resumable, and the
// terminal frames stay authoritative. Text still buffered when a flush is
// skipped by the settlement boundary (cancel/terminal/marker) is exactly the
// text that was never committed — crash loss is bounded by the flush window.

import type { Db } from '@/db/client';
import {
  type CopilotRunProgressEvent,
  publishCopilotRunProgressEvent,
} from './copilot-run-settlement';

export const COPILOT_PROGRESS_FLUSH_MS = 150;
export const COPILOT_PROGRESS_FLUSH_CHARS = 400;

export interface CopilotRunProgressWriter {
  push(progress: CopilotRunProgressEvent): void;
  /** Flush the buffered delta and settle the serialized write chain. */
  drain(): Promise<void>;
}

export function createCopilotRunProgressWriter(deps: {
  db: Db;
  runId: string;
  onDeltaAccepted?: (text: string) => void;
}): CopilotRunProgressWriter {
  let chain: Promise<void> = Promise.resolve();
  let buffered = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearFlushTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // A failed write never poisons later frames and never fails the run; the
  // terminal path reports its own outcome either way.
  const enqueue = (publish: () => Promise<void>) => {
    chain = chain.catch(() => undefined).then(publish);
  };

  const flushDelta = () => {
    if (!buffered) return;
    const text = buffered;
    buffered = '';
    clearFlushTimer();
    enqueue(() =>
      publishCopilotRunProgressEvent(
        deps.db,
        deps.runId,
        { kind: 'delta', text },
        deps.onDeltaAccepted,
      ),
    );
  };

  const scheduleFlush = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushDelta();
    }, COPILOT_PROGRESS_FLUSH_MS);
    // A pending flush must not pin the worker process after the run settles.
    timer.unref?.();
  };

  return {
    push(progress) {
      if (progress.kind === 'delta') {
        buffered += progress.text;
        if (buffered.length >= COPILOT_PROGRESS_FLUSH_CHARS) flushDelta();
        else scheduleFlush();
        return;
      }
      flushDelta();
      enqueue(() =>
        publishCopilotRunProgressEvent(deps.db, deps.runId, {
          kind: 'step',
          payload: progress.payload,
        }),
      );
    },
    async drain() {
      clearFlushTimer();
      flushDelta();
      await chain;
    },
  };
}
