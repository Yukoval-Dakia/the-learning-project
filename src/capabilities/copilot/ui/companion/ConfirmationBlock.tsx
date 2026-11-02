import { useRef, useState } from 'react';
import { Button } from '@/ui-next/public';
import type { ConfirmationAssessmentRenderer, ConfirmationProjection } from '../confirmation';
import type { ConfirmationAction } from './turn-sender';
import '@/ui-next/practice-studio/confirmation.css';

export function ConfirmationBlock(p: {
  confirmation: ConfirmationProjection;
  renderer?: ConfirmationAssessmentRenderer;
  disabled: boolean;
  onCommand(action: ConfirmationAction): Promise<void>;
  onRefresh(): void;
}) {
  const { occurrence: o, assessment } = p.confirmation;
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  const locked = p.disabled || sent;
  async function act(action: ConfirmationAction) {
    if (locked || busy.current) return;
    busy.current = true;
    setSent(true);
    try {
      await p.onCommand(action);
    } catch (cause) {
      setSent(false);
      setError(cause instanceof Error ? cause.message : String(cause));
      if (action.kind === 'submit') throw cause;
    } finally {
      busy.current = false;
    }
  }
  const submitted =
    assessment !== null &&
    typeof assessment === 'object' &&
    'submission' in assessment &&
    assessment.submission !== null &&
    assessment.submission !== undefined;
  const Renderer = p.renderer;
  const states = {
    offered: '用一道题确认一下？',
    declined: '这次先不做',
    deferred: '已经记下，稍后再做',
    blocked: '暂时无法提供这道确认题',
    issued: '对话内确认题',
  };
  return (
    <section className="un-confirm" aria-label="对话内确认题">
      <h3>{states[o.state]}</h3>
      {o.state === 'offered' && (
        <>
          <p>可以现在做一道，也可以拒绝或延期；不会因为你说懂了就记为掌握。</p>
          <div className="un-confirm-actions">
            <Button
              variant="primary"
              disabled={locked}
              onClick={() => void act({ kind: 'accept' })}
            >
              接受一道题
            </Button>
            <Button disabled={locked} onClick={() => void act({ kind: 'decline' })}>
              这次不做
            </Button>
            <Button variant="ghost" disabled={locked} onClick={() => void act({ kind: 'defer' })}>
              稍后再做
            </Button>
          </div>
        </>
      )}
      {o.blocked_reason && <p>原因：{o.blocked_reason}。不会自动生成或换题。</p>}
      {o.state === 'issued' &&
        (assessment === null ? (
          <p role="status">正在等候完整题目快照，请读取原对话。</p>
        ) : Renderer ? (
          <Renderer
            occurrenceId={o.occurrence_id}
            sessionId={o.session_id}
            assessment={assessment}
            disabled={locked}
            onSubmit={(response_set, group_evidence) =>
              act({ kind: 'submit', response_set, group_evidence })
            }
            onRefresh={p.onRefresh}
          />
        ) : (
          <p role="alert">当前界面未接入原生作答展示，暂不能提交。</p>
        ))}
      {(o.state === 'declined' || o.state === 'deferred' || o.state === 'blocked' || submitted) && (
        <Button disabled={locked} onClick={() => void act({ kind: 'request_again' })}>
          再确认一次
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      {sent && (
        <p role="status">
          动作已交给对话发送链。若接纳未确认，使用原发送记录恢复；这里不会另建提交。
        </p>
      )}
      <Button variant="ghost" onClick={p.onRefresh}>
        刷新原对话记录
      </Button>
    </section>
  );
}
