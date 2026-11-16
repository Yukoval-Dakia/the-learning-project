// What the companion is thinking, for this visit only: live frames are never replayed and never
// stored. A retried attempt replaces the one it names; a gap in seq starts a new paragraph.
import type { CopilotRunThinkingFrame, CopilotRunView } from '../subtask-events';
import { COPILOT_RUN_STEP_EVENT, parseRequestRetry } from '../subtask-events';

export interface ThinkingSegment {
  taskRunId: string;
  lastSeq: number;
  text: string;
}

/** Once the reply has landed or the run ended, a late frame says nothing true any more. */
export function thinkingClosed(view: CopilotRunView, stopped: boolean): boolean {
  return (
    stopped ||
    view.phase === 'completed' ||
    view.phase === 'failed' ||
    typeof view.replyPayload?.reply_md === 'string'
  );
}

export function addThinkingFrame(
  segments: readonly ThinkingSegment[],
  frame: CopilotRunThinkingFrame,
): readonly ThinkingSegment[] {
  const current = segments.find((segment) => segment.taskRunId === frame.task_run_id);
  if (!current) {
    return [...segments, { taskRunId: frame.task_run_id, lastSeq: frame.seq, text: frame.text }];
  }
  if (frame.seq <= current.lastSeq) return segments;
  const gap = frame.seq > current.lastSeq + 1;
  return segments.map((segment) =>
    segment === current
      ? {
          ...segment,
          lastSeq: frame.seq,
          text: `${segment.text}${gap ? '\n\n' : ''}${frame.text}`,
        }
      : segment,
  );
}

/** The text to show now; empty once the final reply says the stream is not what it became. */
export function visibleThinking(
  segments: readonly ThinkingSegment[],
  view: CopilotRunView,
): string {
  if (view.thinkingClear) return '';
  const replaced = new Set<string>();
  for (const frame of view.frames) {
    if (frame.event_type !== COPILOT_RUN_STEP_EVENT) continue;
    if (frame.payload.step_kind !== 'request_sent') continue;
    if (typeof frame.payload.retry_of === 'string') replaced.add(frame.payload.retry_of);
  }
  return segments
    .filter((segment) => !replaced.has(segment.taskRunId))
    .map((segment) => segment.text)
    .join('\n\n');
}

/**
 * A retried request takes back the thinking its broken attempt streamed. Each retry trims once,
 * when it first arrives: a replay after reconnecting finds that thinking already gone (live frames
 * are never replayed), and `applied` keeps it from cutting what came after.
 */
export function trimThinkingForRetries(
  segments: readonly ThinkingSegment[],
  view: CopilotRunView,
  applied: Set<number>,
): readonly ThinkingSegment[] {
  let next = segments;
  for (const frame of view.frames) {
    if (frame.event_type !== COPILOT_RUN_STEP_EVENT || applied.has(frame.event_id)) continue;
    const retry = parseRequestRetry(frame.payload);
    if (!retry) continue;
    applied.add(frame.event_id);
    if (retry.discard_thinking_chars === 0) continue;
    next = next.map((segment) =>
      segment.taskRunId === retry.task_run_id
        ? {
            ...segment,
            text: segment.text.slice(
              0,
              Math.max(0, segment.text.length - retry.discard_thinking_chars),
            ),
          }
        : segment,
    );
  }
  return next;
}
