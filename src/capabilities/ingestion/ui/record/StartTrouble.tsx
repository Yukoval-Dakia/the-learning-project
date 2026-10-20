import { Button } from '@/ui-next/public';
import { START_WORDS, stopWords } from './record-copy';
import { type StartState, retryStart, startRecording } from './record-start';
import type { Recording } from './recording-model';

/**
 * What to do when a recording has not started, could not start, or stopped. Nothing here retries
 * on its own and nothing switches lanes on its own: every next step is a button the learner presses.
 */
export function StartTrouble({
  rec,
  start,
  paper,
}: {
  rec: Recording;
  start: StartState | null;
  paper: boolean;
}) {
  const busy = start?.status === 'starting';
  const extract = (
    <Button
      variant="primary"
      disabled={busy}
      onClick={() => void startRecording(rec.id, 'extract')}
    >
      {rec.phase === 'failed' ? '改用普通识别' : '开始认题'}
    </Button>
  );

  if (start?.status === 'failed' && start.problem) {
    const words = START_WORDS[start.problem];
    const canRetry = start.problem !== 'quota_used' && start.problem !== 'agent_not_allowed';
    return (
      <div className="rc-trouble" role="alert">
        <p className="rc-trouble-title">{words.title}</p>
        <p>{words.body}</p>
        <div className="rc-actions">
          {start.lane === 'agent' ? (
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void startRecording(rec.id, 'extract')}
            >
              改用普通识别
            </Button>
          ) : null}
          {canRetry && (
            <Button
              variant={start.lane === 'agent' ? 'secondary' : 'primary'}
              disabled={busy}
              onClick={() => void retryStart(rec.id)}
            >
              再试一次
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (busy) return null;

  if (rec.phase === 'not_started') {
    return (
      <div className="rc-trouble" data-tone="neutral">
        <p>材料已经收到，还没开始整理。</p>
        <div className="rc-actions">
          {extract}
          {paper && (
            <Button variant="secondary" onClick={() => void startRecording(rec.id, 'agent')}>
              让录入助手整理
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (rec.phase === 'failed') {
    const agentStopped = rec.lane === 'agent';
    const canRetryAgent = agentStopped && (rec.stop?.retryable ?? true);
    return (
      <div className="rc-trouble" role="alert">
        <p className="rc-trouble-title">
          {agentStopped ? stopWords(rec.stop?.code ?? null, 'session') : '这次没认出来。'}
        </p>
        <p>已经进了题库的题不受影响。</p>
        <div className="rc-actions">
          {agentStopped ? (
            extract
          ) : (
            <Button variant="primary" onClick={() => void startRecording(rec.id, 'extract')}>
              再认一次
            </Button>
          )}
          {canRetryAgent && (
            <Button variant="secondary" onClick={() => void startRecording(rec.id, 'agent')}>
              让录入助手再试一次
            </Button>
          )}
        </div>
      </div>
    );
  }
  return null;
}
