// Above the composer: each live run with its stage and 停止 (Stop is explicit and durable; closing
// the companion never stops anything), then the notices that need the learner — an unconfirmed
// send to recover, a dropped progress stream to reconnect, a refresh to retry after a revert, a
// plain error — and, when the shown conversation cannot take a new message, why and what to do.

import { CircleAlert, LoaderCircle, Plus, RefreshCw, Square } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/ui-next/public';
import type { CompanionController } from './companion-controller';
import {
  conversationReady,
  currentPendingTurns,
  currentRuns,
  selectedSession,
  selectionValidated,
} from './companion-state';
import { PROGRESS_LABELS } from './run-copy';
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
  const error = useCompanion(controller, (s) => s.error);
  const refreshFailed = useCompanion(controller, (s) => s.refreshFailed);
  const { runs: tracker, sender, actions } = controller;

  return (
    <div className="un-cp-footer-notes">
      {runs.map((run) => {
        const stopping = run.stopPending || run.cancelRequested;
        return (
          <div key={run.runId} className="un-cp-run" data-phase={run.phase}>
            <LoaderCircle size={14} aria-hidden="true" className="un-cp-spin un-cp-run-glyph" />
            <span className="un-cp-run-label" aria-live="polite">
              {run.cancelRequested ? '正在停止…' : PROGRESS_LABELS[run.stage]}
            </span>
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
              <Button
                variant="ghost"
                size="sm"
                disabled={turn.dispatching}
                onClick={() => sender.discardPendingRecovery(turn.idempotencyKey)}
              >
                不再恢复
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={turn.dispatching}
                onClick={() => sender.retryPendingTurn(turn.idempotencyKey)}
              >
                <RefreshCw size={13} aria-hidden="true" />
                {turn.dispatching ? '恢复中…' : '恢复'}
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
                重新连接
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
