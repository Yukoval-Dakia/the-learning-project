// The companion (学习伙伴) channel: how pages reach the one companion instance from another
// subtree. Two small module-level stores:
//   • open requests — a page asks the companion to open (optionally with a prefill, a skill
//     context or a nudge); the companion claims each request exactly once;
//   • focus — what the learner is looking at (a question, a knowledge point, a note, an ingestion
//     session). Pages publish it from event handlers with setCompanionFocus; the companion shows
//     「正在看：<title>」 and sends {kind,id} as ambient_context.focused_entity.
// Opening always needs an explicit action; the legacy dwell / revisit auto-open is gone (YUK-577).

'use client';

import { create } from 'zustand';
import type { CopilotSkillContextT } from '@/capabilities/copilot/ui-public';

// AF S4 / YUK-203 U6 — a single pending open-with-context request published by a
// cross-tree caller (e.g. the learning-items 「对话教学」 button) and consumed by
// the companion once on open. `seq` is a monotonically incrementing nonce so the
// companion can distinguish a brand-new request from a re-render with the same
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
   * How the companion treats `prefill`: 'send' sends it as the next turn when the
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
 * The companion's attach command: claim a request published before it mounted, then every
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

/** Open the companion as a normal free-form turn (no fake entity/skill ref). */
export function openCopilot(prefill?: string, options?: CopilotOpenOptions): void {
  useCopilotOpenSignal.getState().openCopilot(prefill, options);
}

/**
 * Cross-tree opener for the companion, seeded with a skill context.
 * Buttons outside the companion subtree call this; the companion subscribes to the
 * store and opens itself, sending the next turn with the skill context.
 */
export function openCopilotWith(skillContext: CopilotSkillContextT, prefill?: string): void {
  useCopilotOpenSignal.getState().openCopilotWith(skillContext, prefill);
}

/**
 * YUK-577 — open the companion for a proactive nudge 「看看」click: the headline
 * seeds the agent opening turn client-side, and session_id rides into ambient_context.
 */
export function openCopilotForNudge(nudge: CopilotNudgeOpen): void {
  useCopilotOpenSignal.getState().openCopilotForNudge(nudge);
}

/** What the learner is looking at, as the companion shows and sends it. */
export interface CompanionFocus {
  /** Entity kind sent as focused_entity.kind, e.g. 'question' | 'knowledge' | 'note' | 'learning_session'. */
  kind: string;
  id: string;
  /** Learner-visible title for 「正在看：…」. */
  title: string;
}

// The focus belongs to the page that published it: it is recorded with that page's path and read
// back only while the learner is still on that path, so leaving the page drops it.
const useCompanionFocusStore = create<{ focus: CompanionFocus | null; path: string | null }>(
  () => ({ focus: null, path: null }),
);

function currentPath(): string | null {
  return typeof window === 'undefined' ? null : window.location.pathname;
}

/** Publish (or clear with null) what the learner is looking at. Call from event handlers. */
export function setCompanionFocus(focus: CompanionFocus | null): void {
  useCompanionFocusStore.setState({ focus, path: focus ? currentPath() : null });
}

/** Send-time read for the companion's commands. */
export function readCompanionFocus(): CompanionFocus | null {
  const { focus, path } = useCompanionFocusStore.getState();
  return focus && path === currentPath() ? focus : null;
}

/** Render-time read (useSyncExternalStore through zustand). */
export function useCompanionFocus(): CompanionFocus | null {
  const state = useCompanionFocusStore();
  return state.focus && state.path === currentPath() ? state.focus : null;
}
