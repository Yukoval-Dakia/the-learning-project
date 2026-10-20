// The steps a reply took, one quiet line each, between the question and the answer: tool calls,
// processing steps and background helpers. State changes in place (进行中 → 完成 / 没完成); a row
// with a summary opens it beneath itself. Internal error text never renders.

import { Check, CircleAlert, CircleSlash, LoaderCircle } from 'lucide-react';
import { memo, useId, useState } from 'react';
import { Expand } from '@/ui-next/public';
import type { ChatMessage } from '../message-projection';
import type { ReplaySubagentRun, ReplayToolOperation } from '../replay';
import { toolLabel } from './tool-labels';

type StepStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface StepView {
  key: string;
  label: string;
  status: StepStatus;
  /** One plain line; done → what came back, failed → what to do. */
  detail?: string;
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
      status: call.status,
      detail:
        call.status === 'failed'
          ? `${label}暂时没完成，稍后再试。`
          : call.status === 'done'
            ? call.summary
            : undefined,
    });
  });
  for (const subtask of message.subtasks ?? []) {
    const status: StepStatus =
      subtask.status === 'completed' ? 'done' : subtask.status === 'failed' ? 'failed' : 'running';
    steps.push({
      key: `subtask-${subtask.id}`,
      label: subtask.label,
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
      status,
      detail: lifecycleDetail(status, op.status === 'lost'),
    });
  }
  for (const run of message.subagent_runs ?? []) {
    const status = lifecycleStatus(run.status);
    steps.push({
      key: `helper-${run.id}`,
      label: '分头查资料',
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
      <span className="un-cp-step-status">{STATUS_COPY[step.status]}</span>
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
