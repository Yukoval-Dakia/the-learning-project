import { Button } from '@/ui-next/public';
import { BlockLine } from './BlockLine';
import { IMPORTABLE_STATUS, useImportDraft } from './import-draft';
import type { Block } from './record-api';
import { reviewLine } from './record-copy';
import { useReviewCheck } from './review-check';

/** Statuses in which a question can still be read again from its page (server rescue rule). */
const RESCUABLE = new Set(['partial', 'extracted']);

/**
 * Recognised questions and the one action that puts them into the library. Questions the learner
 * marked as wrong go in with their answer; the rest go in as plain questions. Putting them in
 * finishes the recording, so it waits until every kept question is complete; leaving the
 * unfinished ones out is its own, named choice.
 */
export function BlockLines({
  sessionId,
  status,
  blocks,
  photos,
  onHoverPage,
  navigate,
  reviewable,
}: {
  sessionId: string;
  status: string;
  blocks: Block[];
  /** A classic recording read only in part: the learner checks every question before import. */
  reviewable: boolean;
  /** The material is photos or PDF pages, which a question can be read again from. */
  photos: boolean;
  onHoverPage: (page: number | null) => void;
  navigate: (to: string) => void;
}) {
  const draft = useImportDraft(sessionId, blocks);
  const check = useReviewCheck(sessionId, blocks);
  const open = IMPORTABLE_STATUS.has(status);
  const locked = draft.send.isPending || (reviewable && check.locked);
  const left = blocks.filter((b) => b.status === 'draft').length;
  const waiting = draft.waiting.length;

  if (blocks.length === 0) return null;
  return (
    <>
      <ol className="rc-lines" aria-label="认出的题">
        {blocks.map((block, i) => (
          <BlockLine
            key={block.id}
            sessionId={sessionId}
            block={block}
            no={i + 1}
            edit={draft.editOf(block)}
            onEdit={(patch) => draft.update(block, patch)}
            locked={locked}
            closed={!open}
            rescuable={photos && RESCUABLE.has(status)}
            onRead={() => draft.forgetText(block)}
            onHoverPage={onHoverPage}
            check={
              reviewable
                ? {
                    marked: check.isMarked(block),
                    disabled: !check.canMark(block),
                    onToggle: () => check.toggle(block),
                  }
                : undefined
            }
          />
        ))}
      </ol>
      {draft.send.isSuccess && (draft.send.variables ?? 0) > 0 && (
        <p className="rc-saved" role="status">
          其中 {draft.send.variables} 道记在「做错过」里。
          <button
            type="button"
            className="rc-link"
            onClick={() => navigate('/questions?view=mistakes')}
          >
            去看看
          </button>
        </p>
      )}
      {reviewable && (
        <div className="rc-bar rc-bar-sticky">
          <span className="rc-quiet" aria-live="polite">
            {reviewLine(check)}
          </span>
          <div className="rc-actions">
            <Button variant="primary" disabled={!check.canConfirm} onClick={check.confirm}>
              {check.sending
                ? '正在记下…'
                : check.lookingUp
                  ? '查一下结果'
                  : `都看过了 · ${check.marked} / ${check.total}`}
            </Button>
          </div>
        </div>
      )}
      {open && left > 0 && (
        <div className="rc-bar rc-bar-sticky">
          <span className="rc-quiet" aria-live="polite">
            {draft.send.isError
              ? '没收进去，再试一次。'
              : waiting > 0
                ? `还有 ${waiting} 道差一点，补好再收；收的时候没收的题就不再留了。`
                : draft.skippedCount > 0
                  ? `另外 ${draft.skippedCount} 道不收，收完就不再留了。`
                  : draft.wrongCount > 0
                    ? `${draft.wrongCount} 道记成做错过`
                    : '都可以收了'}
          </span>
          <div className="rc-actions">
            {waiting > 0 && (
              <Button variant="ghost" disabled={locked} onClick={draft.skipWaiting}>
                其余 {waiting} 道不收
              </Button>
            )}
            <Button
              variant="primary"
              disabled={draft.ready.length === 0 || waiting > 0 || locked}
              onClick={() => draft.send.mutate(draft.wrongCount)}
            >
              {locked ? '正在收…' : `收进题库 · ${draft.ready.length} 道`}
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
