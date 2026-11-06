// What a run shows while it is live: the progress stage and the reconnect sentence after a
// dropped stream. The AI reply bubble carries only real reply text; no placeholder goes there.

import { type CopilotRunView, DurablePickupStalledError } from '../subtask-events';
import type { ProgressStage } from './companion-state';

export const PROGRESS_LABELS: Record<ProgressStage, string> = {
  dispatch: '马上来',
  generation: '在回答',
  'evidence-review': '在核对',
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

export const CONNECTION_LOST_COPY = '连接断了，连上就接着说';

export const PICKUP_STALLED_COPY = '这条排队比平时久，可以再看看。';

export function isPickupStalled(cause: unknown): boolean {
  return cause instanceof DurablePickupStalledError;
}
