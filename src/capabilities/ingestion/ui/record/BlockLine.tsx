import { useState } from 'react';
import { RescueButton, RevertButton } from './BlockTools';
import { promptOf } from './block-text';
import type { QuestionEdit, Readiness } from './import-draft';
import { readiness } from './import-draft';
import { KnowledgePick } from './KnowledgePick';
import type { Block } from './record-api';

const READY_WORDS: Record<Readiness, { text: string; tone: string }> = {
  ready: { text: '可以收', tone: 'positive' },
  needs_knowledge: { text: '还差知识点', tone: 'caution' },
  needs_answer: { text: '还差你的答案', tone: 'caution' },
  needs_text: { text: '没有题目文字', tone: 'caution' },
  skipped: { text: '不收', tone: 'neutral' },
};

/** One recognised question: its text, and only what the library still needs from the learner. */
export function BlockLine({
  sessionId,
  block,
  no,
  edit,
  onEdit,
  locked,
  closed,
  rescuable,
  onRead,
  onHoverPage,
  check,
}: {
  sessionId: string;
  block: Block;
  no: number;
  edit: QuestionEdit;
  onEdit: (patch: Partial<QuestionEdit>) => void;
  locked: boolean;
  /** The recording no longer takes questions in; a left-over draft just reads as not taken. */
  closed: boolean;
  /** The recording still lets a question be read again from its page. */
  rescuable: boolean;
  onRead: () => void;
  onHoverPage: (page: number | null) => void;
  /** The learner's own「看过了」mark, while a partly read recording is being checked. */
  check?: { marked: boolean; disabled: boolean; onToggle: () => void };
}) {
  const [editing, setEditing] = useState(false);
  const first = block.page_spans?.[0];
  const page = first ? first.page_index + 1 : null;
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
          : block.status === 'draft'
            ? { text: '还没收', tone: 'neutral' }
            : { text: '没收', tone: 'neutral' };
    return (
      <li className="rc-line" data-checked={check?.marked} {...hover}>
        <span className="rc-line-no un-num">{no}</span>
        <div className="rc-line-main">
          <p className="rc-line-text">{promptOf(block) || '（没认出文字）'}</p>
          <div className="rc-line-tools">
            {check && (
              <label className="rc-switch rc-switch-sm">
                <input
                  type="checkbox"
                  checked={check.marked}
                  disabled={check.disabled}
                  onChange={check.onToggle}
                />
                <span>看过了</span>
              </label>
            )}
            {block.status === 'auto_enrolled' && (
              <RevertButton sessionId={sessionId} blockId={block.id} disabled={locked} />
            )}
            {block.status === 'draft' && rescuable && (
              <RescueButton sessionId={sessionId} block={block} disabled={locked} onRead={onRead} />
            )}
          </div>
        </div>
        <span className="rc-state rc-line-state" data-tone={done.tone}>
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
          <KnowledgePick
            value={edit.knowledgeIds}
            onChange={(ids) => onEdit({ knowledgeIds: ids })}
            disabled={locked}
          />
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
          {rescuable && !edit.skip && (
            <RescueButton sessionId={sessionId} block={block} disabled={locked} onRead={onRead} />
          )}
        </div>
        {edit.wrong && !edit.skip && (
          <label className="rc-field">
            <span className="rc-field-label">我当时的答案</span>
            <textarea
              className="rc-area rc-area-sm"
              rows={2}
              value={edit.answer}
              placeholder="照着当时写的抄下来，错的也照抄"
              disabled={locked}
              onChange={(e) => onEdit({ answer: e.target.value })}
            />
          </label>
        )}
      </div>
      <span className="rc-state rc-line-state" data-tone={ready.tone}>
        {ready.text}
      </span>
    </li>
  );
}
