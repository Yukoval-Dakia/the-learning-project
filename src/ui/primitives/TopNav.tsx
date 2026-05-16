'use client';

import type { ReactNode } from 'react';
import { BrandMark } from './Brand';

export interface NavItem {
  id: string;
  label: string;
}

const DEFAULT_NAV_ITEMS: NavItem[] = [
  { id: 'today', label: '今日' },
  { id: 'record', label: '录入' },
  { id: 'review', label: '复习' },
  { id: 'mistakes', label: '错题' },
  { id: 'items', label: '学习项' },
  { id: 'knowledge', label: '知识' },
];

export interface TopNavProps {
  active?: string;
  onNav?: (id: string) => void;
  /** Extra content for right side (e.g. Copilot button) */
  trailing?: ReactNode;
  items?: NavItem[];
  /** Version string shown in mono type on the right */
  version?: string;
}

export function TopNav({
  active,
  onNav,
  trailing,
  items = DEFAULT_NAV_ITEMS,
  version,
}: TopNavProps) {
  return (
    <nav
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--s-1)',
        padding: '10px 24px',
        background: 'var(--paper-raised)',
        borderBottom: '1px solid var(--line)',
        position: 'sticky',
        top: 0,
        zIndex: 20,
      }}
    >
      {/* Brand */}
      <button
        type="button"
        onClick={() => onNav?.('today')}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-2)',
          paddingRight: 14,
          marginRight: 'var(--s-2)',
          background: 'transparent',
          borderTop: 'none',
          borderLeft: 'none',
          borderBottom: 'none',
          borderRight: '1px solid var(--line)',
          cursor: 'pointer',
        }}
      >
        <span style={{ color: 'var(--coral)', display: 'flex' }}>
          <BrandMark size={22} />
        </span>
        <span
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 18,
            fontWeight: 500,
            color: 'var(--ink)',
            letterSpacing: 'var(--ls-tight)',
          }}
        >
          Loom
        </span>
      </button>

      {/* Nav items */}
      <ul style={{ listStyle: 'none', display: 'flex', gap: 2 }}>
        {items.map((item) => {
          const isActive = active === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onNav?.(item.id)}
                style={{
                  fontSize: '13.5px',
                  fontWeight: 500,
                  color: isActive ? 'var(--ink)' : 'var(--ink-3)',
                  padding: '6px 10px',
                  borderRadius: 'var(--r-2)',
                  background: isActive ? 'var(--paper-tint)' : 'transparent',
                  whiteSpace: 'nowrap',
                  transition:
                    'color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out)',
                }}
              >
                {item.label}
              </button>
            </li>
          );
        })}
      </ul>

      {/* Right meta */}
      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--s-3)',
          flexShrink: 0,
        }}
      >
        {version && (
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: '11.5px',
              color: 'var(--ink-4)',
              letterSpacing: 'var(--ls-wide)',
              whiteSpace: 'nowrap',
            }}
          >
            {version}
          </span>
        )}
        {trailing}
      </div>
    </nav>
  );
}
