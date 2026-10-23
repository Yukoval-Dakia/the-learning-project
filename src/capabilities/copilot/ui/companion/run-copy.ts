// What a run shows while it is live: the progress stage, the placeholder text before any reply
// arrives, and the reconnect sentence after a dropped stream.

import { type CopilotRunView, DurablePickupStalledError } from '../subtask-events';
import type { ActiveRun } from './companion-context';
import type { ProgressStage } from './companion-state';

export const PROGRESS_LABELS: Record<ProgressStage, string> = {
  dispatch: '准备中…',
  generation: '生成中…',
  'evidence-review': '核对证据中…',
};

export function isTerminal(view: CopilotRunView): boolean {
  return view.phase === 'completed' || view.phase === 'failed';
}

function stageForLabel(label: string): ProgressStage {
  return /证据|审阅|审查|核对|验证|校验|review|evidence|audit|validat/i.test(label)
    ? 'evidence-review'
    : 'generation';
}

export function progressStage(view: CopilotRunView): ProgressStage {
  if (view.phase === 'queued') return 'dispatch';
  const latestStep = [...view.frames].reverse().find((f) => f.event_type === 'copilot_run.step');
  const label = latestStep?.payload.label;
  if (typeof label === 'string' && label.length > 0) return stageForLabel(label);
  const subtask = view.subtasks.at(-1);
  return subtask ? stageForLabel(subtask.label) : 'generation';
}

export function fallbackText(run: ActiveRun): string {
  if (run.view.phase === 'queued') return '正在等待处理这次请求。';
  if (run.view.phase === 'cancel_requested' || run.cancelRequested) return '正在停止这次运行。';
  return '正在处理你的请求，结果会在这里显示。';
}

export function reconnectCopy(cause: unknown): string {
  return cause instanceof DurablePickupStalledError
    ? '这条还在排队等开始；请求已经保留，可以稍后重新连接。'
    : '进度连接断了；它可能还在后台进行，可以重新连接。';
}
