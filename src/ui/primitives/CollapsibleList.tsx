// CollapsibleList — history and secondary long lists fold by default (owner 2026-10-18 14:05,
// docs/design/2026-10-07-ui-visual-direction.md L5). Shows the first `limit` items in the order
// the caller already uses, plus one quiet toggle: 「全部 N 条」 / 「收起」. At or below the limit
// there is no toggle. The open state is local and not persisted.
//
// Works on both surfaces: the toggle reads the ui-next tokens (--un-*) when it sits inside
// [data-ui-next] and falls back to the loom tokens elsewhere. Folded items are not rendered, so
// nothing hidden is reachable by keyboard or assistive tech (A1).

import type { ReactNode } from 'react';
import { useId, useState } from 'react';
import { LoomIcon } from './LoomIcon';
import './collapsible-list.css';

export interface CollapsibleListProps<T> {
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

export function CollapsibleList<T>({
  items,
  renderItem,
  limit = 3,
  as: List = 'ol',
  className,
  toggleClassName,
}: CollapsibleListProps<T>) {
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
          className={['cl-toggle', 'un-hit', toggleClassName].filter(Boolean).join(' ')}
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? '收起' : `全部 ${items.length} 条`}
          <LoomIcon name="chevronDown" size={13} className="cl-toggle-chev" />
        </button>
      )}
    </>
  );
}
