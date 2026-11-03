// What a run shows while it is live: the progress stage and the reconnect sentence after a
// dropped stream. The AI reply bubble carries only real reply text; no placeholder goes there.

import { type CopilotRunView, DurablePickupStalledError } from '../subtask-events';
import type { ProgressStage } from './companion-state';

export const PROGRESS_LABELS: Record<ProgressStage, string> = {
  dispatch: '准备中…',
  generation: '生成中…',
  'evidence-review': '核对证据中…',
};

export function isTerminal(view: CopilotRunView): boolean {
  return view.phase === 'completed' || view.phase === 'failed';
}

/**
 * The stage comes from structured run facts only, never from label wording: a queued run is still
 * being dispatched; a running subtask (the evidence researcher, `step_kind: 'subtask'`) means the
 * answer is being checked against evidence; anything else is generation.
 */
export function progressStage(view: CopilotRunView): ProgressStage {
  if (view.phase === 'queued') return 'dispatch';
  return view.subtasks.some((subtask) => subtask.status === 'running')
    ? 'evidence-review'
    : 'generation';
}

export function reconnectCopy(cause: unknown): string {
  return cause instanceof DurablePickupStalledError
    ? '这条还在排队等开始；请求已经保留，可以稍后重新连接。'
    : '进度连接断了；它可能还在后台进行，可以重新连接。';
}
