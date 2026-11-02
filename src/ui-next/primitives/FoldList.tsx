import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { useId, useState } from 'react';

export interface FoldListProps<T> {
  items: readonly T[];
  /** Render one item; return a keyed element (an `li` when `as` is `ol`/`ul`). */
  renderItem: (item: T, index: number, shownCount: number) => ReactNode;
  /** How many items show while folded. Default 3. */
  limit?: number;
  /** The list element. Default `ol`. */
  as?: 'ol' | 'ul' | 'div';
  /** Class for the list element (keep the list's existing class here). */
  className?: string;
  /** Extra class for the toggle, e.g. to line it up with the list's text column. */
  toggleClassName?: string;
}

/**
 * A secondary long list that folds by default (owner 2026-10-18, visual direction L5): the first
 * `limit` items in the caller's order, plus one quiet 「全部 N 条」/「收起」 toggle. At or below the
 * limit there is no toggle. Folded items are not rendered, so nothing hidden is reachable (A1).
 */
export function FoldList<T>({
  items,
  renderItem,
  limit = 3,
  as: List = 'ol',
  className,
  toggleClassName,
}: FoldListProps<T>) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const foldable = items.length > limit;
  const shown = foldable && !open ? items.slice(0, limit) : items;

  return (
    <>
      <List id={listId} className={className}>
        {shown.map((item, index) => renderItem(item, index, shown.length))}
      </List>
      {foldable && (
        <button
          type="button"
          className={['un-fold-toggle', 'un-hit', toggleClassName].filter(Boolean).join(' ')}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '收起' : `全部 ${items.length} 条`}
          <ChevronDown size={14} aria-hidden="true" className="un-fold-chev" />
        </button>
      )}
    </>
  );
}
