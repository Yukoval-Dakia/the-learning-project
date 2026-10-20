import { Button } from '@/ui-next/public';
import { BlockLine } from './BlockLine';
import { IMPORTABLE_STATUS, useImportDraft } from './import-draft';
import type { Block } from './record-api';

/**
 * Recognised questions and the one action that puts the ready ones into the library. Questions
 * the learner marked as wrong go in with their answer; the rest go in as plain questions.
 */
export function BlockLines({
  sessionId,
  status,
  blocks,
  onHoverPage,
  navigate,
}: {
  sessionId: string;
  status: string;
  blocks: Block[];
  onHoverPage: (page: number | null) => void;
  navigate: (to: string) => void;
}) {
  const draft = useImportDraft(sessionId, blocks);
  const open = IMPORTABLE_STATUS.has(status);
  const locked = draft.send.isPending;
  const left = blocks.filter((b) => b.status === 'draft').length;

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
            onHoverPage={onHoverPage}
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
      {open && left > 0 && (
        <div className="rc-bar rc-bar-sticky">
          <span className="rc-quiet" aria-live="polite">
            {draft.send.isError
              ? '没收进去，再试一次。'
              : [
                  draft.waiting.length > 0 ? `还有 ${draft.waiting.length} 道差一点` : null,
                  draft.wrongCount > 0 ? `${draft.wrongCount} 道记成做错过` : null,
                ]
                  .filter(Boolean)
                  .join('，') || '都可以收了'}
          </span>
          <Button
            variant="primary"
            disabled={draft.ready.length === 0 || locked}
            onClick={() => draft.send.mutate(draft.wrongCount)}
          >
            {locked ? '正在收…' : `收进题库 · ${draft.ready.length} 道`}
          </Button>
        </div>
      )}
    </>
  );
}
