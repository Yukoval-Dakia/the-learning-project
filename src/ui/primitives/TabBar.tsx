'use client';

import type { ReactNode } from 'react';

export interface TabItem {
  id: string;
  label: ReactNode;
}

export interface TabBarProps {
  items: TabItem[];
  active: string;
  onSelect: (id: string) => void;
  className?: string;
}

/** Segmented tab strip — matches loom-design-v2 `.seg-row` + `.seg` */
export function TabBar({ items, active, onSelect, className }: TabBarProps) {
  return (
    <div className={['seg-row', className ?? ''].filter(Boolean).join(' ')}>
      {items.map((item) => {
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            className={['seg', isActive ? 'is-on' : ''].filter(Boolean).join(' ')}
            aria-pressed={isActive}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
