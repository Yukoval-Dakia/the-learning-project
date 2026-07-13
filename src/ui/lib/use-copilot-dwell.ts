// Global Copilot drawer open-state hook. The legacy first-visit dwell timer and
// return-visit localStorage auto-open were removed in YUK-577: opening now always
// requires an explicit user action or a qualified cross-tree signal.
//
// The hook exposes a boolean (`open`) plus controlled setters so the
// drawer parent can also drive open state from a manual trigger button.
//
// AF S4 / YUK-203 U6 — cross-tree open-with-context channel. The drawer `open`
// flag is component-local (it lives inside CopilotDock's hook instance), so a
// button in a DIFFERENT subtree (e.g. learning-items/[id]) cannot reach it to
// open the Dock pre-seeded with a skill. A tiny module-level Zustand store —
// co-located here, NOT a separate store file — carries an `openCopilotWith`
// signal that CopilotDock subscribes to. The §5.1 plan ruling: lift the
// open-with-context signal into a shared store; CopilotDock reads it alongside
// its dwell hook.

'use client';

import type { CopilotSkillContextT } from '@/capabilities/copilot/server/chat';
import { useCallback, useState } from 'react';
import { create } from 'zustand';

export interface UseCopilotDwellResult {
  open: boolean;
  /** Open the drawer manually (e.g. from a header button). */
  openDrawer: () => void;
  /** Close the drawer; no implicit timer or revisit path may reopen it. */
  closeDrawer: () => void;
}

// AF S4 / YUK-203 U6 — a single pending open-with-context request published by a
// cross-tree caller (e.g. the learning-items 「对话教学」 button) and consumed by
// CopilotDock once on open. `seq` is a monotonically incrementing nonce so the
// Dock can distinguish a brand-new request from a re-render with the same
// payload (two consecutive teaching opens for the same item, say).
// YUK-577 — a proactive-nudge open. The deterministic nudge headline IS the agent's
// opening turn (seeded client-side, agent-authored — never an owner user bubble, MF1);
// session_id rides into ambient_context so the user's reply is context-aware.
export interface CopilotNudgeOpen {
  nudge_event_id: string;
  session_id: string;
  headline: string;
}

export interface CopilotOpenRequest {
  seq: number;
  // Optional: nudge opens carry no skill context (free-form agent opening).
  skill_context?: CopilotSkillContextT;
  /** Optional message to auto-send on open (none today; reserved for §5.1). */
  prefill?: string;
  /** YUK-577 — set when the open was triggered by a proactive-nudge 「看看」click. */
  nudge?: CopilotNudgeOpen;
}

interface CopilotOpenSignalStore {
  request: CopilotOpenRequest | null;
  /** Open a free-form Copilot turn without fabricating a skill/entity context. */
  openCopilot: (prefill?: string) => void;
  /** YUK-577 — publish a proactive-nudge open (headline as agent opening + session ambient). */
  openCopilotForNudge: (nudge: CopilotNudgeOpen) => void;
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
  openCopilot: (prefill) =>
    set((s) => {
      const seq = s.nextSeq + 1;
      return { nextSeq: seq, request: { seq, prefill } };
    }),
  openCopilotWith: (skillContext, prefill) =>
    set((s) => {
      const seq = s.nextSeq + 1;
      return {
        nextSeq: seq,
        request: { seq, skill_context: skillContext, prefill },
      };
    }),
  openCopilotForNudge: (nudge) =>
    set((s) => {
      const seq = s.nextSeq + 1;
      return { nextSeq: seq, request: { seq, nudge } };
    }),
  clearRequest: () => set({ request: null }),
  // nextSeq is intentionally NOT reset on clearRequest — it must monotonically
  // increase so the Dock's lastHandledSeqRef never matches a future open.
}));

/** Open the global drawer as a normal free-form turn (no fake entity/skill ref). */
export function openCopilot(prefill?: string): void {
  useCopilotOpenSignal.getState().openCopilot(prefill);
}

/**
 * Cross-tree opener for the global CopilotDock, seeded with a skill context.
 * Buttons outside the Dock subtree call this; CopilotDock subscribes to the
 * store and opens itself, sending the next turn with the skill context.
 */
export function openCopilotWith(skillContext: CopilotSkillContextT, prefill?: string): void {
  useCopilotOpenSignal.getState().openCopilotWith(skillContext, prefill);
}

/**
 * YUK-577 — open the global CopilotDock for a proactive nudge 「看看」click: the headline
 * seeds the agent opening turn client-side, and session_id rides into ambient_context.
 */
export function openCopilotForNudge(nudge: CopilotNudgeOpen): void {
  useCopilotOpenSignal.getState().openCopilotForNudge(nudge);
}

export function useCopilotDwell(): UseCopilotDwellResult {
  const [open, setOpen] = useState(false);

  const openDrawer = useCallback(() => setOpen(true), []);
  const closeDrawer = useCallback(() => setOpen(false), []);

  return { open, openDrawer, closeDrawer };
}
