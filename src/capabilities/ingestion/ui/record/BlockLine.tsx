import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { QuestionEdit, Readiness } from './import-draft';
import { readiness } from './import-draft';
import { KnowledgePick } from './KnowledgePick';
import { type Block, revertBlock } from './record-api';
import { recordKeys } from './recording-read';

const READY_WORDS: Record<Readiness, { text: string; tone: string }> = {
  ready: { text: '可以收', tone: 'positive' },
  needs_knowledge: { text: '还差知识点', tone: 'caution' },
  needs_answer: { text: '还差你的答案', tone: 'caution' },
  needs_text: { text: '没有题目文字', tone: 'caution' },
  skipped: { text: '不收', tone: 'neutral' },
};

function RevertButton({ sessionId, blockId }: { sessionId: string; blockId: string }) {
  const [asking, setAsking] = useState(false);
  const qc = useQueryClient();
  const undo = useMutation({
    mutationFn: () => revertBlock(sessionId, blockId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: recordKeys.blocks(sessionId) }),
  });
  if (undo.isError) return <span className="rc-problem">没撤回成功，再试一次。</span>;
  return (
    <button
      type="button"
      className="rc-link"
      disabled={undo.isPending}
      onClick={() => (asking ? undo.mutate() : setAsking(true))}
      onBlur={() => setAsking(false)}
    >
      {asking ? '确定撤回？' : '撤回'}
    </button>
  );
}

/** One recognised question: its text, and only what the library still needs from the learner. */
export function BlockLine({
  sessionId,
  block,
  no,
  edit,
  onEdit,
  locked,
  closed,
  onHoverPage,
}: {
  sessionId: string;
  block: Block;
  no: number;
  edit: QuestionEdit;
  onEdit: (patch: Partial<QuestionEdit>) => void;
  locked: boolean;
  /** The recording no longer takes questions in; a left-over draft just reads as not taken. */
  closed: boolean;
  onHoverPage: (page: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const page = block.page_spans[0] ? block.page_spans[0].page_index + 1 : null;
  const hover = {
    onPointerEnter: () => onHoverPage(page),
    onPointerLeave: () => onHoverPage(null),
  };

  if (block.status !== 'draft' || closed) {
    const done =
      block.status === 'imported'
        ? { text: '已进题库', tone: 'positive' }
        : block.status === 'auto_enrolled'
          ? { text: '已自动进题库', tone: 'positive' }
          : { text: '没收', tone: 'neutral' };
    return (
      <li className="rc-line" {...hover}>
        <span className="rc-line-no un-num">{no}</span>
        <div className="rc-line-main">
          <p className="rc-line-text">{block.extracted_prompt_md}</p>
          {block.status === 'auto_enrolled' && (
            <RevertButton sessionId={sessionId} blockId={block.id} />
          )}
        </div>
        <span className="rc-state" data-tone={done.tone}>
          {done.text}
        </span>
      </li>
    );
  }

  const ready = READY_WORDS[readiness(edit)];
  return (
    <li className="rc-line" data-skip={edit.skip} {...hover}>
      <span className="rc-line-no un-num">{no}</span>
      <div className="rc-line-main">
        {editing ? (
          <textarea
            className="rc-area rc-area-sm"
            rows={4}
            value={edit.prompt}
            aria-label={`第 ${no} 题的文字`}
            disabled={locked}
            onChange={(e) => onEdit({ prompt: e.target.value })}
          />
        ) : (
          <p className="rc-line-text">{edit.prompt || '（没认出文字）'}</p>
        )}
        {!edit.skip && (
          <>
            <KnowledgePick
              value={edit.knowledgeIds}
              onChange={(ids) => onEdit({ knowledgeIds: ids })}
              disabled={locked}
            />
            {edit.wrong && (
              <textarea
                className="rc-area rc-area-sm"
                rows={2}
                value={edit.answer}
                placeholder="我当时的答案，错的也照抄"
                aria-label={`第 ${no} 题我当时的答案`}
                disabled={locked}
                onChange={(e) => onEdit({ answer: e.target.value })}
              />
            )}
          </>
        )}
        <div className="rc-line-tools">
          {!edit.skip && (
            <label className="rc-switch rc-switch-sm">
              <input
                type="checkbox"
                checked={edit.wrong}
                disabled={locked}
                onChange={(e) => onEdit({ wrong: e.target.checked })}
              />
              <span>这题我做错了</span>
            </label>
          )}
          {!edit.skip && (
            <button
              type="button"
              className="rc-link"
              disabled={locked}
              onClick={() => setEditing(!editing)}
            >
              {editing ? '改好了' : '改字'}
            </button>
          )}
          <button
            type="button"
            className="rc-link"
            disabled={locked}
            onClick={() => onEdit({ skip: !edit.skip })}
          >
            {edit.skip ? '还是收' : '不收这道'}
          </button>
        </div>
      </div>
      <span className="rc-state" data-tone={ready.tone}>
        {ready.text}
      </span>
    </li>
  );
}
