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
//
// YUK-1483: the shown value is read from the page (useSyncExternalStore): an explicit
// <html data-theme> wins, otherwise the saved choice. It re-reads when the attribute
// changes or another tab writes the key. The server snapshot is 'light'.

import { useSyncExternalStore } from 'react';

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
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'auto') return raw;
  } catch {
    // Storage may be unavailable in some sandboxes.
  }
  return 'light';
}

function readThemePref(): ThemePref {
  const applied = document.documentElement.getAttribute('data-theme');
  if (applied === 'light' || applied === 'dark') return applied;
  return readSavedTheme();
}

function readServerThemePref(): ThemePref {
  return 'light';
}

function subscribeThemePref(notify: () => void): () => void {
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) notify();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    observer.disconnect();
    window.removeEventListener('storage', onStorage);
  };
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
  const pref = useSyncExternalStore(subscribeThemePref, readThemePref, readServerThemePref);

  const cycle = () => {
    const next = NEXT[pref];
    // Persist first so the attribute change notification reads the new saved value.
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable in some sandboxes — silently no-op.
    }
    applyTheme(next);
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
