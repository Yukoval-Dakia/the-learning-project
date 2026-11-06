// Above the composer: each live run with its stage and 停止 (Stop is explicit and durable; closing
// the companion never stops anything), then the notices that need the learner — an unconfirmed
// send to recover, a dropped progress stream to reconnect, a refresh to retry after a revert, a
// plain error — and, when the shown conversation cannot take a new message, why and what to do.

import { ChevronDown, CircleAlert, LoaderCircle, Plus, RefreshCw, Square } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/ui-next/public';
import type { CompanionController } from './companion-controller';
import {
  conversationReady,
  currentPendingTurns,
  currentRuns,
  selectedSession,
  selectionValidated,
} from './companion-state';
import { CONNECTION_LOST_COPY, PROGRESS_LABELS } from './run-copy';
import { LiveActivity } from './ToolRow';
import { useCompanion, useCompanionShallow } from './use-companion';

function Notice({
  tone,
  children,
  actions,
}: {
  tone: 'caution' | 'critical' | 'quiet';
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="un-cp-notice" data-tone={tone} role={tone === 'quiet' ? 'status' : 'alert'}>
      {tone === 'quiet' ? null : (
        <CircleAlert size={15} aria-hidden="true" className="un-cp-notice-icon" />
      )}
      <p className="un-cp-notice-text">{children}</p>
      {actions ? <div className="un-cp-notice-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * The one activity line. Thinking stays folded behind it on every turn, because a model can write a
 * question's answer in its thoughts before the reply; opening it shows the live text.
 */
function RunLine({
  controller,
  runId,
  children,
}: {
  controller: CompanionController;
  runId: string;
  children: ReactNode;
}) {
  const text = useCompanion(controller, (s) => s.thinkingByRun[runId] ?? '');
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (!text) {
    return (
      <span aria-hidden="true" className="un-cp-run-line">
        {children}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        className="un-cp-run-line un-cp-run-toggle un-hit"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
        <span className="un-sr-only">{open ? '，收起在想的内容' : '，看看在想什么'}</span>
        <ChevronDown size={14} aria-hidden="true" data-open={open ? '' : undefined} />
      </button>
      {open ? (
        <div id={panelId} className="un-cp-thinking">
          <p>{text}</p>
        </div>
      ) : null}
    </>
  );
}

function ReadOnlyNotice({ controller }: { controller: CompanionController }) {
  const ready = useCompanion(controller, conversationReady);
  const creating = useCompanion(controller, (s) => s.creatingSession);
  const validated = useCompanion(controller, selectionValidated);
  const listFailed = useCompanion(controller, (s) => s.sessionsStatus === 'error');
  const hasSession = useCompanion(controller, (s) => selectedSession(s) !== undefined);
  const epoch = useCompanion(controller, (s) => s.visit.epoch);
  if (ready) return null;
  const copy = creating
    ? '正在准备新对话…'
    : !validated
      ? listFailed
        ? '对话记录没读出来，可以重试，或者直接开始新对话。'
        : '正在读取对话记录…'
      : hasSession
        ? '这段对话已经结束，只能回看。'
        : '还没有可以接着聊的对话。';
  return (
    <Notice
      tone="quiet"
      actions={
        <>
          {!validated && listFailed ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => controller.sessions.loadVisitSessions(epoch)}
            >
              重试
            </Button>
          ) : null}
          <Button
            variant="primary"
            size="sm"
            disabled={creating}
            onClick={() => void controller.sessions.createConversation()}
          >
            <Plus size={14} aria-hidden="true" />
            {creating ? '创建中…' : '开始新对话'}
          </Button>
        </>
      }
    >
      {copy}
    </Notice>
  );
}

export function RunFooter({ controller }: { controller: CompanionController }) {
  const runs = useCompanionShallow(controller, currentRuns);
  const pending = useCompanionShallow(controller, (s) =>
    currentPendingTurns(s).filter((turn) => turn.error),
  );
  const sending = useCompanion(controller, (s) =>
    currentPendingTurns(s).some((turn) => turn.dispatching && !turn.error),
  );
  const messages = useCompanion(controller, (s) => s.messages);
  const error = useCompanion(controller, (s) => s.error);
  const refreshFailed = useCompanion(controller, (s) => s.refreshFailed);
  const { runs: tracker, sender, actions } = controller;

  return (
    <div className="un-cp-footer-notes">
      {sending && runs.length === 0 ? (
        <div className="un-cp-run">
          <LoaderCircle size={14} aria-hidden="true" className="un-cp-spin un-cp-run-glyph" />
          <span className="un-sr-only" aria-live="polite">
            {PROGRESS_LABELS.dispatch}
          </span>
          <span aria-hidden="true" className="un-cp-run-line">
            <LiveActivity override={PROGRESS_LABELS.dispatch} />
          </span>
        </div>
      ) : null}
      {runs.map((run) => {
        const stopping = run.stopPending || run.cancelRequested;
        const announced = run.cancelRequested
          ? '正在停止…'
          : run.connectionLost
            ? CONNECTION_LOST_COPY
            : PROGRESS_LABELS[run.stage];
        return (
          <div key={run.runId} className="un-cp-run" data-phase={run.phase}>
            <LoaderCircle size={14} aria-hidden="true" className="un-cp-spin un-cp-run-glyph" />
            {/* The stage is announced; every step and second on the visible line would flood. */}
            <span className="un-sr-only" aria-live="polite">
              {announced}
            </span>
            <RunLine controller={controller} runId={run.runId}>
              <LiveActivity
                message={messages.find((m) => m.role === 'ai' && m.run_id === run.runId)}
                override={
                  run.cancelRequested || run.connectionLost || run.stage === 'dispatch'
                    ? announced
                    : undefined
                }
              />
            </RunLine>
            <Button
              variant="quiet"
              size="sm"
              disabled={stopping}
              onClick={() => void tracker.stopRun(run.runId)}
            >
              <Square size={12} aria-hidden="true" />
              {stopping ? '停止中…' : '停止'}
            </Button>
          </div>
        );
      })}
      {pending.map((turn) => (
        <Notice
          key={turn.idempotencyKey}
          tone="caution"
          actions={
            <>
              {turn.requestBody.confirmation ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={turn.dispatching}
                  onClick={() => sender.discardPendingRecovery(turn.idempotencyKey)}
                >
                  算了
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                disabled={turn.dispatching}
                onClick={() => sender.retryPendingTurn(turn.idempotencyKey)}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {turn.dispatching ? '发送中…' : '再发一次'}
              </Button>
            </>
          }
        >
          {turn.error}
        </Notice>
      ))}
      {runs
        .filter((run) => run.connectionError)
        .map((run) => (
          <Notice
            key={`reconnect-${run.runId}`}
            tone="caution"
            actions={
              <Button variant="secondary" size="sm" onClick={() => tracker.reconnectRun(run.runId)}>
                <RefreshCw size={13} aria-hidden="true" />
                再看看
              </Button>
            }
          >
            {run.connectionError}
          </Notice>
        ))}
      {refreshFailed ? (
        <Notice
          tone="caution"
          actions={
            <Button variant="secondary" size="sm" onClick={() => void actions.retryRefresh()}>
              <RefreshCw size={13} aria-hidden="true" />
              刷新
            </Button>
          }
        >
          已经撤回了，但对话没刷新出来。
        </Notice>
      ) : error ? (
        <Notice tone="critical">{error}</Notice>
      ) : null}
      <ReadOnlyNotice controller={controller} />
    </div>
  );
}
