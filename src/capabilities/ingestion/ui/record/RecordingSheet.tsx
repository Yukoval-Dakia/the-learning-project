import { useState } from 'react';
import { RetryLine } from '@/ui-next/primitives/RetryLine';
import { SkeletonLines } from '@/ui-next/primitives/SkeletonLines';
import { AgentLines } from './AgentLines';
import { BlockLines } from './BlockLines';
import { PageStrip } from './PageStrip';
import { PriorRuns } from './PriorRuns';
import { GAP_WORDS, materialWords, receiptWords, warningWords, whenWords } from './record-copy';
import { useStartState } from './record-start';
import { useRecording } from './recording-read';
import { recordingTitle } from './recording-title';
import { reviewOffered } from './review-check';
import { StartTrouble } from './StartTrouble';
import { statusWords } from './status-words';

/**
 * One recording. The same sheet serves the live run and a recording reopened from the list. A
 * finished one is rebuilt from its stored history: each question as it was when the run finished,
 * today's state as its own line, and plain words for whatever the record could not keep.
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
  const {
    recording: rec,
    detail,
    title: serverTitle,
    failedToLoad,
    retry,
  } = useRecording(sessionId);
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
  const title = recordingTitle(rec, serverTitle);
  const receipt = detail.usage_receipt;
  const inBank =
    rec.items.some((i) => i.status === 'withheld' || i.status === 'admitted' || i.now !== null) ||
    rec.blocks.some((b) => b.status === 'imported' || b.status === 'auto_enrolled');
  const working = rec.phase === 'working';
  const warning = rec.phase === 'failed' ? null : warningWords(facts.warnings ?? []);
  const agentAllowed = receipt?.derivation_policy !== 'answer_only';
  const meter =
    working && rec.pages && rec.pages.total > 0 ? rec.pages.done / rec.pages.total : null;

  return (
    <article className="rc-sheet" aria-label="一次录入" data-phase={rec.phase}>
      <header className="rc-sheet-head">
        <div className="rc-sheet-title">
          <h2 className="rc-row-title">
            {[rec.createdAt !== null ? whenWords(rec.createdAt, now) : null, title]
              .filter(Boolean)
              .join(' · ')}
          </h2>
          <p className="rc-sheet-meta">
            {materialWords(facts.entrypoint, facts.source_asset_ids.length)}
          </p>
        </div>
        <button type="button" className="rc-link" onClick={onClose}>
          收起
        </button>
      </header>

      <p className="rc-status" data-tone={status.tone} aria-live="polite">
        {status.text}
      </p>
      {status.detail && <p className="rc-quiet">{status.detail}</p>}
      {warning && <p className="rc-quiet">{warning}</p>}
      {working && (
        <div className="rc-meter" data-indeterminate={meter === null} aria-hidden="true">
          <span
            style={meter === null ? undefined : { transform: `scaleX(${Math.max(0.04, meter)})` }}
          />
        </div>
      )}

      <PageStrip assetIds={facts.source_asset_ids} litPage={litPage} />

      <StartTrouble
        rec={rec}
        start={start}
        paper={facts.entrypoint === 'vision_paper' && agentAllowed}
      />

      {rec.read === 'loading' && <SkeletonLines rows={3} label="正在找回这次的过程" />}
      {rec.read === 'unreadable' && (
        <RetryLine message="这次录入的过程暂时读不出来。" onRetry={retry} />
      )}
      {rec.gaps.length > 0 && (
        <ul className="rc-gaps">
          {rec.gaps.map((g) => (
            <li key={g}>{GAP_WORDS[g]}</li>
          ))}
        </ul>
      )}

      {rec.blocksRead === 'failed' && (
        <RetryLine message="认出的题暂时读不出来。" onRetry={retry} />
      )}
      {rec.blocksRead === 'loading' && rec.read !== 'loading' && (
        <SkeletonLines rows={3} label="正在找回认出的题" />
      )}
      {(rec.blocksRead === 'none' || rec.blocksRead === 'ready') && (
        <AgentLines
          sessionId={rec.id}
          items={rec.items}
          asks={rec.asks}
          onHoverPage={setLitPage}
          stopped={rec.phase === 'failed' || rec.phase === 'finished'}
        />
      )}
      {rec.blocks.length > 0 && (
        <BlockLines
          sessionId={rec.id}
          status={rec.status}
          blocks={rec.blocks}
          photos={facts.entrypoint === 'vision_single' || facts.entrypoint === 'vision_paper'}
          onHoverPage={setLitPage}
          navigate={navigate}
          reviewable={reviewOffered(rec)}
        />
      )}

      <PriorRuns sessionId={rec.id} runs={rec.priorRuns} onHoverPage={setLitPage} />

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
        {(inBank || rec.gaps.includes('expired')) && (
          <button type="button" className="rc-link" onClick={() => navigate('/questions')}>
            去题目库看这些题
          </button>
        )}
      </footer>
    </article>
  );
}
