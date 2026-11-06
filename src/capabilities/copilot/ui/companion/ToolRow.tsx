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

// The server's generic names for a helper run. A specific label reads fine as it is.
const SUBTASK_WORDS: Readonly<Record<string, string>> = {
  正在深入核对证据: '仔细核对',
  子任务已完成: '仔细核对',
  子任务未完成: '仔细核对',
};

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
    const label = SUBTASK_WORDS[subtask.label] ?? subtask.label;
    steps.push({
      key: `subtask-${subtask.id}`,
      label,
      activity: `在${label}`,
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
      activity: '在分头查资料',
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
  waiting: '想一下',
  thinking: '思考中',
  writing: '在写',
  busy: '有点忙，稍等一下',
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
 * While a reply is being generated, says what the companion is really doing, as a person would, and
 * how long nothing new has come: a running step, or its stage from the run's frames. Never invented
 * progress, and never a word about models or sending.
 * Writing moves on its own, so its seconds only appear once the words have stopped for a moment.
 */
export function LiveActivity({
  message,
  override,
}: {
  /** The reply this run is writing; absent until it lands. */
  message?: ChatMessage;
  /** Says something else than the reply's own progress (queued, stopping). */
  override?: string;
}) {
  const steps = message ? stepsOf(message) : [];
  const textLength = (message?.public_prose?.text ?? message?.text ?? '').trim().length;
  const running = steps.findLast((step) => step.status === 'running');
  const current = message?.stream_stage ?? 'waiting';
  const text = override ?? running?.activity ?? STAGE_WORDS[current];
  const seconds = useSecondsSince(`${text}|${steps.length}|${textLength}`);
  const showSeconds = !override && seconds >= (current === 'writing' && !running ? 2 : 1);
  return (
    <>
      <span className="un-cp-activity-text">{text}</span>
      {showSeconds && <span className="un-cp-activity-seconds">{seconds} 秒</span>}
      {steps.length > 0 && <span className="un-cp-activity-count">第 {steps.length} 步</span>}
    </>
  );
}

/**
 * YUK-1664 — the steps of a settled reply: one summary line above the text that opens the full step
 * list. While it is generating, the one status line sits above the composer (RunFooter).
 */
export function StepActivity({ steps }: { steps: StepView[] }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
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
