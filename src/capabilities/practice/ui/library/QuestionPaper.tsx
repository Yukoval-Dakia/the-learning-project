import type { MouseEvent } from 'react';
import { useState } from 'react';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { CollapsibleList } from '@/ui/primitives/CollapsibleList';
import { Expand } from '@/ui-next/public';
import type { QuestionFullDetail } from './library-api';
import { kindWord } from './library-copy';
import { QuestionFigures } from './QuestionFigures';
import { questionHref } from './QuestionLine';

const LETTERS = 'ABCDEFGHIJ';

function useLink(navigate: (to: string) => void) {
  return (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    navigate(href);
  };
}

/**
 * The question on white paper (R2): stem, options, small parts. The answer stays folded behind
 * 「看答案」 so opening a question you got wrong never spoils trying it again.
 */
export function QuestionPaper({
  detail,
  navigate,
  onEdit,
}: {
  detail: QuestionFullDetail;
  navigate: (to: string) => void;
  onEdit?: () => void;
}) {
  const [answerOpen, setAnswerOpen] = useState(false);
  const link = useLink(navigate);
  const choices = detail.choices_md ?? [];
  const variants = detail.family.members.filter((m) => !m.is_self);

  return (
    <section className="qd-paper" aria-labelledby="qd-paper-h">
      <div className="qd-paper-head">
        <h2 id="qd-paper-h" className="qd-label">
          题目
        </h2>
        {onEdit && (
          <button type="button" className="ql-text-btn un-hit" onClick={onEdit}>
            修改
          </button>
        )}
      </div>
      <MathMarkdown className="qd-stem" notation={detail.notation}>
        {detail.prompt_md.trim() || '（这道题没有文字题面）'}
      </MathMarkdown>
      <QuestionFigures detail={detail} />

      {choices.length > 0 && (
        <ol className="qd-choices">
          {choices.map((choice, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: options are positional; text can repeat.
            <li key={`${index}-${choice}`} className="qd-choice">
              <span className="qd-choice-letter">{LETTERS[index] ?? index + 1}</span>
              <MathMarkdown className="qd-choice-text" notation={detail.notation}>
                {choice}
              </MathMarkdown>
            </li>
          ))}
        </ol>
      )}

      {detail.parts.length > 0 && (
        <ol className="qd-parts">
          {detail.parts.map((part) => (
            <li key={part.id}>
              <a
                className="qd-part"
                href={questionHref(part.id)}
                onClick={link(questionHref(part.id))}
              >
                <span className="qd-part-no un-num">{part.part_index + 1}</span>
                <MathMarkdown className="qd-part-stem" notation={detail.notation}>
                  {part.prompt_md}
                </MathMarkdown>
                <span className="qd-part-kind">{kindWord(part.kind)}</span>
              </a>
            </li>
          ))}
        </ol>
      )}

      {detail.reference_md && (
        <div className="qd-answer">
          <button
            type="button"
            className="ql-text-btn un-hit"
            aria-expanded={answerOpen}
            aria-controls="qd-answer"
            onClick={() => setAnswerOpen((open) => !open)}
          >
            {answerOpen ? '收起答案' : '看答案'}
          </button>
          <Expand open={answerOpen} id="qd-answer">
            <MathMarkdown className="qd-answer-body" notation={detail.notation}>
              {detail.reference_md}
            </MathMarkdown>
          </Expand>
        </div>
      )}
      {!detail.reference_md && detail.parts.length === 0 && (
        <p className="qd-quiet">这道题还没有参考答案。</p>
      )}

      {variants.length > 0 && (
        <div className="qd-variants">
          <h3 className="qd-label">同一道题的其他版本</h3>
          <CollapsibleList
            as="ul"
            className="qd-variant-list"
            items={variants}
            renderItem={(member, index) => (
              <li key={member.id}>
                <a href={questionHref(member.id)} onClick={link(questionHref(member.id))}>
                  {member.variant_depth === 0 ? '原题' : `变体 ${index + 1}`} ·{' '}
                  {kindWord(member.kind)}
                </a>
              </li>
            )}
          />
        </div>
      )}
    </section>
  );
}
