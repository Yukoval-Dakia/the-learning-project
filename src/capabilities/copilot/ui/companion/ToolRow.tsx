// The steps a reply took, one quiet line each, between the question and the answer: tool calls,
// processing steps and background helpers. State changes in place (进行中 → 完成 / 没完成); a row
// with a summary opens it beneath itself. Internal error text never renders.

import { Check, ChevronDown, CircleAlert, CircleSlash, LoaderCircle } from 'lucide-react';
import { memo, useId, useState, useSyncExternalStore } from 'react';
import { Expand } from '@/ui-next/public';
import type { ChatMessage } from '../message-projection';
import type { ReplaySubagentRun, ReplayToolOperation } from '../replay';
import type { CopilotModelStage } from '../subtask-events';
import { toolActivity, toolLabel } from './tool-labels';

type StepStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface StepView {
  key: string;
  label: string;
  status: StepStatus;
  /** One plain line; done → what came back, failed → what to do. */
  detail?: string;
  /** YUK-1664 — what this step is doing, said while it runs (「正在查你最近的错题」). */
  activity: string;
}

const STATUS_COPY: Record<StepStatus, string> = {
  running: '进行中',
  done: '完成',
  failed: '没完成',
  cancelled: '已取消',
};

function lifecycleStatus(
  status: ReplayToolOperation['status'] | ReplaySubagentRun['status'],
): StepStatus {
  if (status === 'running') return 'running';
  if (status === 'succeeded') return 'done';
  return status === 'cancelled' ? 'cancelled' : 'failed';
}

function lifecycleDetail(status: StepStatus, lost: boolean): string | undefined {
  if (lost) return '结果暂时无法确认，看完回复再试。';
  return status === 'failed' ? '这一步没完成，稍后再试。' : undefined;
}

/** Flatten a reply's tool calls, steps, operations and helper runs into display rows. */
export function stepsOf(message: ChatMessage): StepView[] {
  const steps: StepView[] = [];
  message.tool_calls?.forEach((call, index) => {
    const label = toolLabel(call.toolName);
    steps.push({
      key: `call-${call.toolUseId ?? `${call.toolName}-${index}`}`,
      label,
      activity: toolActivity(call.toolName),
      status: call.status,
      // YUK-1664 — a tool's own summary is a diagnostic line (counts, flags, English keys), not
      // learner text; only the failure gets a plain line.
      detail: call.status === 'failed' ? `${label}暂时没完成，稍后再试。` : undefined,
    });
  });
  for (const subtask of message.subtasks ?? []) {
    const status: StepStatus =
      subtask.status === 'completed' ? 'done' : subtask.status === 'failed' ? 'failed' : 'running';
    steps.push({
      key: `subtask-${subtask.id}`,
      label: subtask.label,
      activity: `正在处理：${subtask.label}`,
      status,
      detail:
        status === 'failed'
          ? (subtask.error?.replaceAll('子任务', '这一步') ?? '这一步没完成。')
          : subtask.summary,
    });
  }
  for (const op of message.tool_operations ?? []) {
    const status = lifecycleStatus(op.status);
    steps.push({
      key: `op-${op.id}`,
      label: toolLabel(op.tool_name),
      activity: toolActivity(op.tool_name),
      status,
      detail: lifecycleDetail(status, op.status === 'lost'),
    });
  }
  for (const run of message.subagent_runs ?? []) {
    const status = lifecycleStatus(run.status);
    steps.push({
      key: `helper-${run.id}`,
      label: '分头查资料',
      activity: '正在分头查资料',
      status,
      detail: lifecycleDetail(status, run.status === 'lost'),
    });
  }
  return steps;
}

function StatusGlyph({ status }: { status: StepStatus }) {
  if (status === 'running') return <LoaderCircle size={14} className="un-cp-spin" />;
  if (status === 'failed') return <CircleAlert size={14} />;
  if (status === 'cancelled') return <CircleSlash size={14} />;
  return <Check size={14} />;
}

export const ToolRow = memo(function ToolRow({ step }: { step: StepView }) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const line = (
    <>
      <span className="un-cp-step-glyph" aria-hidden="true">
        <StatusGlyph status={step.status} />
      </span>
      <span className="un-cp-step-label">{step.label}</span>
      {/* A done step says so with its check; words only where the learner needs them. */}
      {step.status === 'done' ? (
        <span className="un-sr-only">{STATUS_COPY.done}</span>
      ) : (
        <span className="un-cp-step-status">{STATUS_COPY[step.status]}</span>
      )}
    </>
  );
  return (
    <li className="un-cp-step" data-status={step.status}>
      {step.detail ? (
        <button
          type="button"
          className="un-cp-step-line un-hit"
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen((value) => !value)}
        >
          {line}
        </button>
      ) : (
        <div className="un-cp-step-line">{line}</div>
      )}
      {step.detail ? (
        <Expand open={open} id={detailId}>
          <p className="un-cp-step-detail">{step.detail}</p>
        </Expand>
      ) : null}
    </li>
  );
});

export function StepList({ steps }: { steps: StepView[] }) {
  if (steps.length === 0) return null;
  return (
    <ul className="un-cp-steps" aria-label="处理步骤">
      {steps.map((step) => (
        <ToolRow key={step.key} step={step} />
      ))}
    </ul>
  );
}

const STAGE_WORDS: Record<CopilotModelStage, string> = {
  waiting: '等模型回应',
  thinking: '模型在思考',
  writing: '正在写回答',
};

// One shared clock while any live line is on screen; seconds on the line are the only thing it drives.
let clockNow = Date.now();
let clockTimer: ReturnType<typeof setInterval> | undefined;
const clockListeners = new Set<() => void>();
function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  clockTimer ??= setInterval(() => {
    clockNow = Date.now();
    for (const notify of clockListeners) notify();
  }, 1000);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = undefined;
    }
  };
}
const readClock = () => clockNow;

/** Whole seconds since `key` last changed. */
function useSecondsSince(key: string): number {
  const [mark, setMark] = useState({ key, at: Date.now() });
  if (mark.key !== key) setMark({ key, at: Date.now() });
  const now = useSyncExternalStore(subscribeClock, readClock, readClock);
  return mark.key === key ? Math.max(0, Math.floor((now - mark.at) / 1000)) : 0;
}

/**
 * While a reply is being generated, says what is really happening and how long nothing new has
 * come: a running step, or the model's own stage from the run's frames. Never an invented progress.
 * Writing moves on its own, so its seconds only appear once the words have stopped for a moment.
 */
function LiveActivity({
  steps,
  stage,
  textLength,
}: {
  steps: StepView[];
  stage?: CopilotModelStage;
  textLength: number;
}) {
  const running = steps.findLast((step) => step.status === 'running');
  const current = stage ?? (textLength > 0 ? 'writing' : 'waiting');
  const nothingYet = current === 'waiting' && steps.length === 0 && textLength === 0;
  const text = running?.activity ?? (nothingYet ? '收到了，等模型回应' : STAGE_WORDS[current]);
  const seconds = useSecondsSince(`${text}|${steps.length}|${textLength}`);
  const showSeconds = seconds >= (current === 'writing' && !running ? 2 : 1);
  return (
    // Not a live region: RunFooter already announces the run's stage politely; announcing every
    // step or second here too would flood a screen reader.
    <p className="un-cp-activity" aria-live="off">
      <span className="un-cp-step-glyph" aria-hidden="true">
        <LoaderCircle size={14} className="un-cp-spin" />
      </span>
      <span className="un-cp-activity-text">{text}</span>
      {showSeconds && <span className="un-cp-activity-seconds">{seconds} 秒</span>}
      {steps.length > 0 && <span className="un-cp-activity-count">第 {steps.length} 步</span>}
    </p>
  );
}

/**
 * YUK-1664 — the steps of one reply as the learner should see them. While the reply is being
 * generated (`live`), one status line under the text says what the companion is doing right now and
 * updates in place; earlier steps are not listed. Once the reply settles it folds into one summary
 * line above the text that opens the full step list. The only motion is the running spinner and
 * the chevron turning on open.
 */
export function StepActivity({
  steps,
  live,
  stage,
  textLength = 0,
}: {
  steps: StepView[];
  live: boolean;
  /** Live only: what the model is doing right now. */
  stage?: CopilotModelStage;
  /** Live only: how much reply text is on screen. */
  textLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (live) return <LiveActivity steps={steps} stage={stage} textLength={textLength} />;
  if (steps.length === 0) return null;
  const failed = steps.filter((step) => step.status === 'failed').length;
  const summary =
    failed > 0 ? `用了 ${steps.length} 步，其中 ${failed} 步没完成` : `用了 ${steps.length} 步`;
  return (
    <div className="un-cp-activity-done" data-failed={failed > 0 ? '' : undefined}>
      <button
        type="button"
        className="un-cp-step-line un-hit"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="un-cp-step-glyph" aria-hidden="true">
          {failed > 0 ? <CircleAlert size={14} /> : <Check size={14} />}
        </span>
        <span className="un-cp-step-label">{summary}</span>
        <ChevronDown size={14} aria-hidden="true" className="un-cp-activity-chev" />
      </button>
      <Expand open={open} id={listId}>
        <StepList steps={steps} />
      </Expand>
    </div>
  );
}
