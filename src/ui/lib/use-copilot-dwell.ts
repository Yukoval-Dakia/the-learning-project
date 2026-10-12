// Global Copilot drawer open-state hook. The legacy first-visit dwell timer and
// return-visit localStorage auto-open were removed in YUK-577: opening now always
// requires an explicit user action or a qualified cross-tree signal.
//
// The hook exposes `open` plus the visit epoch and controlled setters so the
// drawer parent can also drive open state from a manual trigger button.
//
// AF S4 / YUK-203 U6 — cross-tree open-with-context channel. The drawer `open`
// flag is component-local (it lives inside CopilotDock's hook instance), so a
// button in a DIFFERENT subtree (e.g. learning-items/[id]) cannot reach it to
// open the Dock pre-seeded with a skill. A tiny module-level Zustand store —
// co-located here, NOT a separate store file — carries an `openCopilotWith`
// signal. CopilotDock claims each request exactly once through
// subscribeCopilotOpenRequests, attached from its always-mounted root node.

'use client';

import { useCallback, useRef, useState } from 'react';
import { create } from 'zustand';
import type { CopilotSkillContextT } from '@/capabilities/copilot/ui-public';

export interface CopilotDrawerVisit {
  open: boolean;
  /** Increments on every closed→open transition; one visit = one fresh session read. */
  epoch: number;
}

export interface UseCopilotDwellResult {
  open: boolean;
  /** The current visit's epoch (see CopilotDrawerVisit). */
  epoch: number;
  /**
   * Open the drawer manually (e.g. from a header button). Returns the epoch of the
   * visit this call started, or null when the drawer was already open.
   */
  openDrawer: () => number | null;
  /** Close the drawer; no implicit timer or revisit path may reopen it. */
  closeDrawer: () => void;
  /** The visit as of the latest open/close command, for async continuations. */
  currentVisit: () => CopilotDrawerVisit;
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

export type CopilotPrefillMode = 'send' | 'compose';

export interface CopilotOpenRequest {
  seq: number;
  // Optional: nudge opens carry no skill context (free-form agent opening).
  skill_context?: CopilotSkillContextT;
  /** Optional message to auto-send on open (none today; reserved for §5.1). */
  prefill?: string;
  /**
   * How the Dock treats `prefill`: 'send' sends it as the next turn when the
   * conversation is ready; 'compose' only appends it to the composer for the
   * learner to send. Absent means 'send'.
   */
  prefill_mode?: CopilotPrefillMode;
  /** YUK-577 — set when the open was triggered by a proactive-nudge 「看看」click. */
  nudge?: CopilotNudgeOpen;
}

export interface CopilotOpenOptions {
  /** false = put the prefill in the composer only; never auto-send it. Default true. */
  send?: boolean;
}

interface CopilotOpenSignalStore {
  request: CopilotOpenRequest | null;
  /** Open a free-form Copilot turn without fabricating a skill/entity context. */
  openCopilot: (prefill?: string, options?: CopilotOpenOptions) => void;
  /** YUK-577 — publish a proactive-nudge open (headline as agent opening + session ambient). */
  openCopilotForNudge: (nudge: CopilotNudgeOpen) => void;
  // PR #305 — monotonically increasing counter that survives a claim, so two
  // consecutive identical opens are still two distinct requests.
  nextSeq: number;
  /** Publish an open-with-context request (cross-tree). */
  openCopilotWith: (skillContext: CopilotSkillContextT, prefill?: string) => void;
}

export const useCopilotOpenSignal = create<CopilotOpenSignalStore>((set) => ({
  request: null,
  nextSeq: 0,
  openCopilot: (prefill, options) =>
    set((s) => {
      const seq = s.nextSeq + 1;
      const prefill_mode: CopilotPrefillMode = options?.send === false ? 'compose' : 'send';
      return { nextSeq: seq, request: { seq, prefill, prefill_mode } };
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
  // nextSeq is intentionally never reset — every publish gets a fresh seq.
}));

/**
 * Take the pending open request, if any. Claiming clears it in the same store write,
 * so a request is handled exactly once even if several claims race.
 */
function claimCopilotOpenRequest(): CopilotOpenRequest | null {
  const { request } = useCopilotOpenSignal.getState();
  if (!request) return null;
  useCopilotOpenSignal.setState({ request: null });
  return request;
}

/**
 * The Dock's attach command: claim a request published before it mounted, then every
 * later publish, until the returned unsubscribe runs on detach.
 */
export function subscribeCopilotOpenRequests(
  handle: (request: CopilotOpenRequest) => void,
): () => void {
  const drain = () => {
    const request = claimCopilotOpenRequest();
    if (request) handle(request);
  };
  const unsubscribe = useCopilotOpenSignal.subscribe((state) => {
    if (state.request) drain();
  });
  drain();
  return unsubscribe;
}

/** Open the global drawer as a normal free-form turn (no fake entity/skill ref). */
export function openCopilot(prefill?: string, options?: CopilotOpenOptions): void {
  useCopilotOpenSignal.getState().openCopilot(prefill, options);
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
  const [visit, setVisit] = useState<CopilotDrawerVisit>({ open: false, epoch: 0 });
  // Written only by the two commands below, so async work started in one visit can
  // check whether that visit is still the open one.
  const visitRef = useRef(visit);

  const openDrawer = useCallback(() => {
    if (visitRef.current.open) return null;
    const next = { open: true, epoch: visitRef.current.epoch + 1 };
    visitRef.current = next;
    setVisit(next);
    return next.epoch;
  }, []);
  const closeDrawer = useCallback(() => {
    if (!visitRef.current.open) return;
    const next = { open: false, epoch: visitRef.current.epoch };
    visitRef.current = next;
    setVisit(next);
  }, []);
  const currentVisit = useCallback(() => visitRef.current, []);

  return { open: visit.open, epoch: visit.epoch, openDrawer, closeDrawer, currentVisit };
}
