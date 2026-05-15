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
    <div
      className={className}
      style={{
        display: 'flex',
        gap: 2,
        padding: 3,
        background: 'var(--paper-sunk)',
        borderRadius: 'var(--r-2)',
        width: 'max-content',
      }}
    >
      {items.map((item) => {
        const isActive = active === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item.id)}
            style={{
              padding: '7px 14px',
              borderRadius: 'var(--r-2)',
              fontSize: 13,
              fontWeight: 500,
              color: isActive ? 'var(--ink)' : 'var(--ink-3)',
              background: isActive ? 'var(--paper-raised)' : 'transparent',
              boxShadow: isActive ? 'var(--shadow-1)' : 'none',
              whiteSpace: 'nowrap',
              transition:
                'background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)',
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
