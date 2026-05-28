// Wave 5 / T-D3/B — /today copilot drawer dwell hook.
//
// Behaviour:
//   • First-ever mount of /today: arm a 30s dwell timer. Any "interaction"
//     (mouse, keyboard, scroll, visibility change) resets the timer. When
//     the timer fires without interaction, the drawer auto-floats open.
//   • Subsequent visits (visited flag set in localStorage): open
//     immediately on mount; no 30s wait.
//   • Once the user dismisses the drawer in a session, do not re-open it
//     automatically again in the same session.
//
// The hook exposes a boolean (`open`) plus controlled setters so the
// drawer parent can also drive open state from a manual trigger button.

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export const COPILOT_DWELL_DEFAULT_MS = 30_000;
export const COPILOT_VISITED_KEY = 'loom:today:copilot:visited';

export interface UseCopilotDwellResult {
  open: boolean;
  /** Open the drawer manually (e.g. from a header button). */
  openDrawer: () => void;
  /** Close & remember dismissal for this session. */
  closeDrawer: () => void;
}

interface UseCopilotDwellOpts {
  /** Override the 30s dwell window for tests / overrides. */
  dwellMs?: number;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined';
}

export function useCopilotDwell(opts: UseCopilotDwellOpts = {}): UseCopilotDwellResult {
  const dwellMs = opts.dwellMs ?? COPILOT_DWELL_DEFAULT_MS;
  const [open, setOpen] = useState(false);
  const dismissedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!dismissedRef.current) setOpen(true);
    }, dwellMs);
  }, [dwellMs]);

  // First mount: decide visited vs first-time.
  useEffect(() => {
    if (!isBrowser()) return;
    let visited = false;
    try {
      visited = window.localStorage.getItem(COPILOT_VISITED_KEY) === '1';
    } catch {
      visited = false;
    }
    if (visited) {
      // Subsequent visit: open immediately. No dwell wait.
      setOpen(true);
    } else {
      try {
        window.localStorage.setItem(COPILOT_VISITED_KEY, '1');
      } catch {
        // ignore
      }
      armTimer();
    }
  }, [armTimer]);

  // Interaction resets dwell timer (first-time path only). Once the drawer
  // is open, or dismissed, we don't re-arm — the timer either fired (and
  // opened the drawer) or it was a return-visit and the drawer is already
  // open.
  useEffect(() => {
    if (!isBrowser()) return;
    if (open) return;
    if (dismissedRef.current) return;
    function onInteraction() {
      if (timerRef.current === null) return; // armed only on first visit
      armTimer();
    }
    const events: Array<keyof WindowEventMap> = ['mousemove', 'keydown', 'scroll', 'pointerdown'];
    for (const evt of events) window.addEventListener(evt, onInteraction, { passive: true });
    return () => {
      for (const evt of events) window.removeEventListener(evt, onInteraction);
    };
  }, [open, armTimer]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );

  const openDrawer = useCallback(() => setOpen(true), []);
  const closeDrawer = useCallback(() => {
    dismissedRef.current = true;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
  }, []);

  return { open, openDrawer, closeDrawer };
}
