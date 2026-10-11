import type { ReactNode, RefObject } from 'react';
import { useEffect, useState } from 'react';

export interface TabBarItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  active?: boolean;
  /** The one solid action in the bar (e.g. capture). */
  primary?: boolean;
  /** Visual badge (e.g. a count); hidden from assistive tech, so pair it with badgeLabel. */
  badge?: ReactNode;
  /** Spoken form of the badge, e.g. "3 条待整理". */
  badgeLabel?: string;
}

export interface TabBarProps {
  /** Accessible name, e.g. "主导航". */
  label: string;
  items: readonly TabBarItem[];
  /** Condensed while reading downward (see useScrollCondense): narrower, labels folded away. */
  compact?: boolean;
  /** Yields to a raised sheet; hidden and inert (A1). */
  hidden?: boolean;
}

/**
 * Floating glass tab bar for phones (N3 mechanism; which entries it shows is pending-layer).
 * Each tab's icon carries `data-tab-target="<id>"`, the landing spot for a capture flight (M5).
 */
export function TabBar({ label, items, compact = false, hidden = false }: TabBarProps) {
  return (
    <nav
      className="un-tabbar un-glass"
      aria-label={label}
      data-compact={compact}
      data-hidden={hidden}
      inert={hidden}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="un-tab"
          data-primary={item.primary ?? false}
          aria-current={item.active ? 'page' : undefined}
          onClick={item.onSelect}
        >
          <span className="un-tab-icon" aria-hidden="true" data-tab-target={item.id}>
            {item.icon}
          </span>
          {item.badge !== undefined && (
            <span className="un-tab-badge" aria-hidden="true">
              {item.badge}
            </span>
          )}
          <span className="un-tab-label">{item.label}</span>
          {item.badgeLabel && <span className="un-sr-only">（{item.badgeLabel}）</span>}
        </button>
      ))}
    </nav>
  );
}

/**
 * True while the reader moves down a scroller past `after` px; false again as soon as they head
 * back up (N3: the tab bar condenses while reading and returns on the way back). Small jitters
 * below `step` px are ignored.
 */
export function useScrollCondense(
  scrollRef: RefObject<HTMLElement | null>,
  { after = 80, step = 6 }: { after?: number; step?: number } = {},
): boolean {
  const [condensed, setCondensed] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let last = el.scrollTop;
    const onScroll = () => {
      const top = el.scrollTop;
      const d = top - last;
      if (Math.abs(d) < step) return;
      setCondensed(d > 0 && top > after);
      last = top;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, after, step]);
  return condensed;
}
