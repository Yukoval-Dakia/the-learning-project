'use client';

// ThemeToggle — Loom 3-state cycle: 淡 → 深 → auto → 淡.
//
// - 淡 (default): `data-theme="light"` matches the reference design.
// - 深 (dark): `data-theme="dark"` forces dark tokens.
// - auto: no `data-theme` attribute on <html>, follows prefers-color-scheme
//   via @media in globals.css.
//
// Persistence: `localStorage["loom-theme"]` keeps the choice across reloads.
// No-FOUC: `app/layout.tsx` reads localStorage in a synchronous inline
// <script> *before* React hydrates and sets the attribute. This component
// just exposes the cycle UI and keeps localStorage in sync.

import { useEffect, useState } from 'react';

type ThemePref = 'auto' | 'light' | 'dark';

const STORAGE_KEY = 'loom-theme';

const LABELS: Record<ThemePref, string> = {
  auto: 'auto',
  light: '淡',
  dark: '深',
};

const NEXT: Record<ThemePref, ThemePref> = {
  light: 'dark',
  dark: 'auto',
  auto: 'light',
};

function readSavedTheme(): ThemePref {
  if (typeof window === 'undefined') return 'light';
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  return 'light';
}

function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (pref === 'auto') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', pref);
  }
}

export function ThemeToggle() {
  // Start with 'light' to keep SSR + first paint stable; the inline boot script
  // in app/layout.tsx has already applied the right attribute by now.
  const [pref, setPref] = useState<ThemePref>('light');

  // Hydrate from localStorage on mount (after no-FOUC script has run).
  useEffect(() => {
    setPref(readSavedTheme());
  }, []);

  const cycle = () => {
    const next = NEXT[pref];
    setPref(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable in some sandboxes — silently no-op.
    }
  };

  return (
    <button
      type="button"
      onClick={cycle}
      className="theme-toggle"
      title={`主题：${LABELS[pref]} · 点击切换`}
      aria-label={`切换主题，当前 ${LABELS[pref]}`}
    >
      <span aria-hidden className="dot" />
      <span className="label">{LABELS[pref]}</span>
    </button>
  );
}
