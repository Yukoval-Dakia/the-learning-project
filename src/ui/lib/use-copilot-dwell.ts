// Wave 5 / T-D3/B — global Copilot drawer dwell hook (originally page-scoped;
// CopilotDock is now mounted app-wide in (app)/layout.tsx — AF S2a/S3a).
//
// Behaviour:
//   • First-ever mount: arm a 30s dwell timer. Any "interaction" (mouse,
//     keyboard, scroll, visibility change) resets the timer. When the timer
//     fires without interaction, the drawer auto-floats open.
//   • Subsequent visits (visited flag set in localStorage): open
//     immediately on mount; no 30s wait.
//   • Once the user dismisses the drawer in a session, do not re-open it
//     automatically again in the same session.
//
// The hook exposes a boolean (`open`) plus controlled setters so the
// drawer parent can also drive open state from a manual trigger button.
//
// AF S4 / YUK-203 U6 — cross-tree open-with-context channel. The dwell `open`
// flag is component-local (it lives inside CopilotDock's hook instance), so a
// button in a DIFFERENT subtree (e.g. learning-items/[id]) cannot reach it to
// open the Dock pre-seeded with a skill. A tiny module-level Zustand store —
// co-located here, NOT a separate store file — carries an `openCopilotWith`
// signal that CopilotDock subscribes to. The §5.1 plan ruling: lift the
// open-with-context signal into a shared store; CopilotDock reads it alongside
// its dwell hook.

'use client';

import type { CopilotSkillContextT } from '@/server/copilot/chat';
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';

export const COPILOT_DWELL_DEFAULT_MS = 30_000;
export const COPILOT_VISITED_KEY = 'loom:today:copilot:visited';

export interface UseCopilotDwellResult {
  open: boolean;
  /** Open the drawer manually (e.g. from a header button). */
  openDrawer: () => void;
  /** Close & remember dismissal for this session. */
  closeDrawer: () => void;
}

// AF S4 / YUK-203 U6 — a single pending open-with-context request published by a
// cross-tree caller (e.g. the learning-items 「对话教学」 button) and consumed by
// CopilotDock once on open. `seq` is a monotonically incrementing nonce so the
// Dock can distinguish a brand-new request from a re-render with the same
// payload (two consecutive teaching opens for the same item, say).
export interface CopilotOpenRequest {
  seq: number;
  skill_context: CopilotSkillContextT;
  /** Optional message to auto-send on open (none today; reserved for §5.1). */
  prefill?: string;
}

interface CopilotOpenSignalStore {
  request: CopilotOpenRequest | null;
  // PR #305 fix — monotonically increasing counter that persists across
  // clearRequest() so seq never resets to a value already seen by the Dock's
  // lastHandledSeqRef. Bug: seq was derived from s.request?.seq which reset to
  // null on clear → second openCopilotWith produced seq=1 again → Dock saw
  // seq===lastHandledSeqRef.current (still 1) and silently swallowed the open.
  // Scenario verified: open (seq→1, handled) → clear (request null) →
  // open again (old: seq→1 again, SWALLOWED; new: seq→2, correctly handled).
  nextSeq: number;
  /** Publish an open-with-context request (cross-tree). */
  openCopilotWith: (skillContext: CopilotSkillContextT, prefill?: string) => void;
  /** Consume the pending request (CopilotDock calls this after reading it). */
  clearRequest: () => void;
}

export const useCopilotOpenSignal = create<CopilotOpenSignalStore>((set) => ({
  request: null,
  nextSeq: 0,
  openCopilotWith: (skillContext, prefill) =>
    set((s) => {
      const seq = s.nextSeq + 1;
      return {
        nextSeq: seq,
        request: { seq, skill_context: skillContext, prefill },
      };
    }),
  clearRequest: () => set({ request: null }),
  // nextSeq is intentionally NOT reset on clearRequest — it must monotonically
  // increase so the Dock's lastHandledSeqRef never matches a future open.
}));

/**
 * Cross-tree opener for the global CopilotDock, seeded with a skill context.
 * Buttons outside the Dock subtree call this; CopilotDock subscribes to the
 * store and opens itself, sending the next turn with the skill context.
 */
export function openCopilotWith(skillContext: CopilotSkillContextT, prefill?: string): void {
  useCopilotOpenSignal.getState().openCopilotWith(skillContext, prefill);
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
