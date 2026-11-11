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
  /** Committed prose shrank by this many chars (a published retract). */
  onRetractAccepted?: (chars: number) => void;
}): CopilotRunProgressWriter {
  let chain: Promise<void> = Promise.resolve();
  let buffered = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  // YUK-1548 §5 — latest-wins block_draft slot per tool_use_id; a push replaces
  // the slot and the slot flushes on the same 150ms timer, after buffered prose.
  const blockDrafts = new Map<string, Record<string, unknown>>();

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
    enqueue(async () => {
      await publishCopilotRunProgressEvent(
        deps.db,
        deps.runId,
        { kind: 'delta', text },
        deps.onDeltaAccepted,
      );
    });
  };

  const flushBlockDrafts = () => {
    if (blockDrafts.size === 0) return;
    const slots = [...blockDrafts.values()];
    blockDrafts.clear();
    for (const payload of slots) {
      enqueue(async () => {
        await publishCopilotRunProgressEvent(deps.db, deps.runId, { kind: 'step', payload });
      });
    }
  };

  const scheduleFlush = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushDelta();
      flushBlockDrafts();
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
      if (progress.kind === 'block_draft') {
        const toolUseId = String(progress.payload.tool_use_id ?? '');
        if (toolUseId) {
          blockDrafts.set(toolUseId, progress.payload);
          scheduleFlush();
        }
        return;
      }
      if (progress.kind === 'retract') {
        // Prose still buffered never reached a reader: drop it here, and only
        // the committed remainder rides the published step.
        const fromBuffer = Math.min(progress.payload.discard_chars, buffered.length);
        buffered = buffered.slice(0, buffered.length - fromBuffer);
        const committed = progress.payload.discard_chars - fromBuffer;
        flushDelta();
        flushBlockDrafts();
        enqueue(async () => {
          const published = await publishCopilotRunProgressEvent(deps.db, deps.runId, {
            kind: 'retract',
            payload: { ...progress.payload, discard_chars: committed },
          });
          if (published && committed > 0) deps.onRetractAccepted?.(committed);
        });
        return;
      }
      flushDelta();
      flushBlockDrafts();
      enqueue(async () => {
        await publishCopilotRunProgressEvent(deps.db, deps.runId, {
          kind: 'step',
          payload: progress.payload,
        });
      });
    },
    async drain() {
      clearFlushTimer();
      flushDelta();
      flushBlockDrafts();
      await chain;
    },
  };
}
