// Shared wiring for the companion controller modules. The controller is plain TypeScript (no React):
// commands run from event handlers, ref callbacks and query functions, never during render. Live
// handles (abort controllers, run views) stay here; components only see CompanionState.

import type { QueryClient } from '@tanstack/react-query';
import type { StoreApi } from 'zustand/vanilla';
import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import type { CopilotClient } from '../copilot-client';
import type { ChatMessage } from '../message-projection';
import type { ReplaySkillContext } from '../replay';
import { restoreSkillContext } from '../skill-lifecycle';
import type { CopilotRunView } from '../subtask-events';
import type { CompanionState } from './companion-state';
import type { RunTracker } from './run-tracker';
import type { TurnSender } from './turn-sender';
import type { VisitSessions } from './visit-sessions';

export interface ActiveRun {
  runId: string;
  sessionId: string;
  location: string;
  userMessage?: string;
  derivationPolicy?: DerivationPolicyT;
  view: CopilotRunView;
  controller?: AbortController;
  connectionError?: string;
  stopPending: boolean;
  cancelRequested: boolean;
}

export interface CompanionInternals {
  runs: Map<string, ActiveRun>;
  /** Teaching/quiz skill the next turn routes to; folded from messages on every write. */
  activeSkill: ReplaySkillContext | null;
  /** One-shot ingestion session a nudge 「看看」 opened (ambient focus of the first reply). */
  nudgeSession: string | null;
  bootstrapEpoch: number | null;
  selectionRevision: number;
  snapshotRequestSeq: Map<string, number>;
  snapshotAppliedSeq: Map<string, number>;
  checkingPolicy: boolean;
  storageInitialized: boolean;
}

export interface CompanionCtx {
  store: StoreApi<CompanionState>;
  get: () => CompanionState;
  set: (patch: Partial<CompanionState>) => void;
  client: CopilotClient;
  queryClient: QueryClient;
  /** Distinguishes this mount's query keys from any other instance. */
  instance: string;
  internals: CompanionInternals;
  /** Every message write goes here so the skill context folds the complete order. */
  updateMessages: (next: ChatMessage[] | ((previous: ChatMessage[]) => ChatMessage[])) => void;
  sessions: VisitSessions;
  runs: RunTracker;
  sender: TurnSender;
}

export function createInternals(): CompanionInternals {
  return {
    runs: new Map(),
    activeSkill: null,
    nudgeSession: null,
    bootstrapEpoch: null,
    selectionRevision: 0,
    snapshotRequestSeq: new Map(),
    snapshotAppliedSeq: new Map(),
    checkingPolicy: false,
    storageInitialized: false,
  };
}

export function makeUpdateMessages(
  store: StoreApi<CompanionState>,
  internals: CompanionInternals,
): CompanionCtx['updateMessages'] {
  return (next) => {
    const previous = store.getState().messages;
    const value = typeof next === 'function' ? next(previous) : next;
    if (value === previous) return;
    internals.activeSkill = restoreSkillContext(value, internals.activeSkill);
    store.setState({ messages: value });
  };
}

/** Best-effort reads: a failure is already visible through the sessions status. */
export function swallow(): undefined {
  return undefined;
}

export function nextMessageId(): string {
  return `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
