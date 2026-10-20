import { useState } from 'react';
import { RetryLine, SkeletonLines } from '@/ui-next/public';
import { AgentLines } from './AgentLines';
import { BlockLines } from './BlockLines';
import { PageStrip } from './PageStrip';
import { materialWords, receiptWords, whenWords } from './record-copy';
import { useStartState } from './record-start';
import { useRecording } from './recording-read';
import { StartTrouble } from './StartTrouble';
import { statusWords } from './status-words';

/**
 * One recording. The same sheet serves the live run and a recording reopened from the list: it
 * is rebuilt from the session's own reads every time, so reopening shows what was shown then.
 */
export function RecordingSheet({
  sessionId,
  onClose,
  navigate,
}: {
  sessionId: string;
  onClose: () => void;
  navigate: (to: string) => void;
}) {
  const { recording: rec, detail, failedToLoad, retry } = useRecording(sessionId);
  const start = useStartState(sessionId);
  const [litPage, setLitPage] = useState<number | null>(null);

  if (!detail) {
    return (
      <article className="rc-sheet" aria-label="一次录入">
        {failedToLoad ? (
          <RetryLine message="这次录入暂时打不开。" onRetry={retry} />
        ) : (
          <SkeletonLines rows={4} label="正在打开这次录入" />
        )}
      </article>
    );
  }

  const facts = detail.session;
  const now = Date.now();
  const status = statusWords(rec, start);
  const receipt = detail.usage_receipt;
  const inBank =
    rec.items.some((i) => i.status === 'withheld' || i.status === 'admitted') ||
    rec.blocks.some((b) => b.status === 'imported' || b.status === 'auto_enrolled');
  const working = rec.phase === 'working';
  const meter =
    working && rec.pages && rec.pages.total > 0 ? rec.pages.done / rec.pages.total : null;

  return (
    <article className="rc-sheet" aria-label="一次录入" data-phase={rec.phase}>
      <header className="rc-sheet-head">
        <p className="rc-sheet-meta">
          {materialWords(facts.entrypoint, facts.source_asset_ids.length)}
          {rec.createdAt !== null && ` · ${whenWords(rec.createdAt, now)}`}
        </p>
        <button type="button" className="rc-link" onClick={onClose}>
          收起
        </button>
      </header>

      <p className="rc-status" data-tone={status.tone} aria-live="polite">
        {status.text}
      </p>
      {status.detail && <p className="rc-quiet">{status.detail}</p>}
      {working && (
        <div className="rc-meter" data-indeterminate={meter === null} aria-hidden="true">
          <span
            style={meter === null ? undefined : { transform: `scaleX(${Math.max(0.04, meter)})` }}
          />
        </div>
      )}

      <PageStrip assetIds={facts.source_asset_ids} litPage={litPage} />

      <StartTrouble rec={rec} start={start} paper={facts.entrypoint === 'vision_paper'} />

      {rec.history === 'loading' && <SkeletonLines rows={3} label="正在找回这次的过程" />}

      {rec.lane === 'agent' && (
        <AgentLines sessionId={rec.id} items={rec.items} asks={rec.asks} onHoverPage={setLitPage} />
      )}
      {rec.lane !== 'agent' && (
        <BlockLines
          sessionId={rec.id}
          status={rec.status}
          blocks={rec.blocks}
          onHoverPage={setLitPage}
          navigate={navigate}
        />
      )}

      <footer className="rc-sheet-foot">
        {receipt && (
          <p className="rc-quiet">
            {receiptWords({
              counts: receipt.redaction_counts,
              pagesRaw: receipt.channels?.page_images === 'raw',
              answerOnly: receipt.derivation_policy === 'answer_only',
            })}
          </p>
        )}
        {(inBank || rec.history === 'expired') && (
          <button type="button" className="rc-link" onClick={() => navigate('/questions')}>
            去题目库看这些题
          </button>
        )}
      </footer>
    </article>
  );
}
