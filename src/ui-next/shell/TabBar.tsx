import type { ReactNode } from 'react';

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
  /** Condensed while reading downward. */
  compact?: boolean;
  /** Yields to a raised sheet; hidden and inert (A1). */
  hidden?: boolean;
}

/** Floating glass tab bar for phones (N3 mechanism; which entries it shows is pending-layer). */
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
          <span className="un-tab-icon" aria-hidden="true">
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
