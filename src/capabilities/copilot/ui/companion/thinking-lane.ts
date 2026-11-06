// What the companion is thinking, for this visit only: live frames are never replayed and never
// stored. A retried attempt replaces the one it names; a gap in seq starts a new paragraph.
import type { CopilotRunThinkingFrame, CopilotRunView } from '../subtask-events';
import { COPILOT_RUN_STEP_EVENT } from '../subtask-events';

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
