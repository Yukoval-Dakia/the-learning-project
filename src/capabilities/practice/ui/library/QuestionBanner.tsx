import type { MouseEvent } from 'react';
import { type QuestionFullDetail, isDeleted, isDraft } from './library-api';
import { difficultyWord, holdWords, kindWord, sourceWord } from './library-copy';
import { questionHref, shortDay } from './QuestionLine';

function stateWord(detail: QuestionFullDetail): { word: string; tone: string } | null {
  if (isDeleted(detail)) return { word: '已删除', tone: 'critical' };
  if (isDraft(detail)) return { word: '待审核', tone: 'accent' };
  if (!detail.serving.servable)
    return { word: holdWords(detail.serving.hold_reason).title, tone: 'caution' };
  return null;
}

/**
 * The banner: the big title is what the question practises (its knowledge points, R2), never the
 * stem; under it one line of facts and the question's state, if it is not a normal one.
 */
export function QuestionBanner({
  detail,
  navigate,
}: {
  detail: QuestionFullDetail;
  navigate: (to: string) => void;
}) {
  const title = detail.labels.map((l) => l.name).join('、') || '还没归到知识点的题';
  const state = stateWord(detail);
  const parentHref = detail.parent_question_id ? questionHref(detail.parent_question_id) : null;
  const goParent = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!parentHref || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    navigate(parentHref);
  };
  const facts = [
    detail.parts.length > 0 ? `大题 · ${detail.parts.length} 小题` : kindWord(detail.kind),
    difficultyWord(detail.difficulty),
    sourceWord(detail.source),
    `${shortDay(detail.created_at_sec)} 收进来`,
  ];

  return (
    <header className="qd-banner">
      {parentHref && (
        <a className="qd-parent" href={parentHref} onClick={goParent}>
          这是一道大题的第 {(detail.part_index ?? 0) + 1} 小题 · 看整道题
        </a>
      )}
      <h1 className="qd-title">{title}</h1>
      <p className="qd-facts">
        {state && (
          <span className="ql-state" data-tone={state.tone}>
            {state.word}
          </span>
        )}
        <span>{facts.join(' · ')}</span>
      </p>
    </header>
  );
}
