import type { MouseEvent, ReactNode } from 'react';
import { MathMarkdown } from '@/ui/lib/math-markdown';

const dayFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' });

export function shortDay(sec: number): string {
  return dayFmt.format(new Date(sec * 1000));
}

export function questionHref(id: string): string {
  return `/questions/${encodeURIComponent(id)}`;
}

/**
 * One question in a library list: the stem as prose (clamped to two lines) and a quiet line of
 * facts. The whole line is a real link (open in a new tab works); `lead` sits before the text
 * (a tick box), `aside` after it (a state word, an action).
 */
export function QuestionLine({
  id,
  stem,
  notation,
  facts,
  detail,
  lead,
  aside,
  navigate,
}: {
  id: string;
  stem: string;
  notation?: string | null;
  facts: ReadonlyArray<string | null | false>;
  /** An extra line under the stem, e.g. my wrong answer. */
  detail?: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
  navigate: (to: string) => void;
}) {
  const href = questionHref(id);
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(href);
  };
  const factLine = facts.filter(Boolean).join(' · ');
  return (
    <li className="ql-line">
      {lead}
      <a className="ql-line-main" href={href} onClick={open}>
        <MathMarkdown className="ql-stem" notation={notation}>
          {stem.trim() || '（这道题没有文字题面）'}
        </MathMarkdown>
        {detail}
        {factLine && <span className="ql-facts">{factLine}</span>}
      </a>
      {aside && <div className="ql-line-aside">{aside}</div>}
    </li>
  );
}

/** The list footer: how much is showing, and a way to load more. */
export function LoadMore({
  shown,
  total,
  hasMore,
  loading,
  onMore,
}: {
  shown: number;
  total?: number;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
}) {
  if (shown === 0 && !hasMore) return null;
  const text =
    shown === 0
      ? '已加载的部分里还没有 · 还有更多'
      : total !== undefined
        ? `已显示 ${shown} / ${total} 道`
        : hasMore
          ? `已显示 ${shown} 道 · 还有更多`
          : `已显示 ${shown} 道`;
  return (
    <div className="ql-more">
      <span className="ql-more-text un-num">{text}</span>
      {hasMore && (
        <button type="button" className="ql-text-btn un-hit" onClick={onMore} disabled={loading}>
          {loading ? '正在加载…' : '再加载'}
        </button>
      )}
    </div>
  );
}
