// 学习伙伴 (companion) state: one immutable snapshot per change, read by components through
// useSyncExternalStore (zustand's useStore). Commands live in the controller modules next to this
// file; this module only holds the shape and the pure reads derived from it.

import type { DerivationPolicyT } from '@/core/schema/derivation-policy';
import { DerivationPolicy } from '@/core/schema/derivation-policy';
import { isWithinCopilotReuseWindow } from '../../session-reuse';
import type { CopilotSessionsResponse } from '../copilot-client';
import type { PersistedPendingCopilotTurn } from '../durable-reconnect-storage';
import type { ChatMessage } from '../message-projection';
import type { CopilotRunPhase } from '../subtask-events';

export type CopilotSession = CopilotSessionsResponse['sessions'][number];
export type SelectionOrigin = 'automatic' | 'explicit' | 'recovery';
export type PolicySupport = 'checking' | 'supported' | 'unsupported';
export type ProgressStage = 'dispatch' | 'generation' | 'evidence-review';

/** A pre-202 turn: the exact key + body a recovery must replay. */
export interface PendingTurn extends PersistedPendingCopilotTurn {
  dispatching: boolean;
  error?: string;
}

/** Render view of one accepted server-owned run (the live handles stay in the controller). */
export interface RunSnapshot {
  runId: string;
  sessionId: string;
  phase: CopilotRunPhase;
  stage: ProgressStage;
  /** A stream is attached right now. */
  attached: boolean;
  stopPending: boolean;
  cancelRequested: boolean;
  connectionError?: string;
}

export interface CorrectionTarget {
  turnId: string;
  turnNumber: number;
}

export interface CompanionState {
  /** One visit per open; the epoch increments on every closed → open. */
  visit: { open: boolean; epoch: number };
  /** The current visit's fresh list; only this may authorize automatic reuse. */
  freshSessions: CopilotSessionsResponse | null;
  sessionsStatus: 'idle' | 'loading' | 'ready' | 'error';
  /** Last successful list, kept for display when a later read fails. */
  retainedSessions: CopilotSession[];
  optimisticSession: CopilotSession | null;
  automaticCreatedEpoch: number | null;
  currentSessionId: string | null;
  selectionOrigin: SelectionOrigin;
  creatingSession: boolean;
  messages: ChatMessage[];
  pendingTurns: PendingTurn[];
  runs: RunSnapshot[];
  error: string | null;
  /** The revert landed but the refresh after it failed (never shown as a revert failure). */
  refreshFailed: boolean;
  revertPendingId: string | null;
  chipPending: string | null;
  chipAcked: string | null;
  draft: string;
  correctionTarget: CorrectionTarget | null;
  derivationPolicy: DerivationPolicyT;
  policyCheck: {
    result: PolicySupport;
    epoch: number;
    fresh: CopilotSessionsResponse | null;
  } | null;
  /** Knowledge node carried by an open request's skill context (quiz chip scope). */
  skillKnowledgeId: string | null;
  listOpen: boolean;
}

export const initialCompanionState: CompanionState = {
  visit: { open: false, epoch: 0 },
  freshSessions: null,
  sessionsStatus: 'idle',
  retainedSessions: [],
  optimisticSession: null,
  automaticCreatedEpoch: null,
  currentSessionId: null,
  selectionOrigin: 'automatic',
  creatingSession: false,
  messages: [],
  pendingTurns: [],
  runs: [],
  error: null,
  refreshFailed: false,
  revertPendingId: null,
  chipPending: null,
  chipAcked: null,
  draft: '',
  correctionTarget: null,
  derivationPolicy: 'allow',
  policyCheck: null,
  skillKnowledgeId: null,
  listOpen: false,
};

export function hasServerTime(
  snapshot: CopilotSessionsResponse | null | undefined,
): snapshot is CopilotSessionsResponse {
  return snapshot != null && Number.isFinite(Date.parse(snapshot.server_time));
}

/** Automatic selection may only land on a live session inside the reuse window. */
export function isReusableSession(session: CopilotSession, serverNow: Date): boolean {
  return (
    (session.status === 'active' || session.status === 'idle') &&
    isWithinCopilotReuseWindow(session.updated_at, serverNow)
  );
}

export function isContinuable(session: CopilotSession | undefined): boolean {
  return session?.status === 'active' || session?.status === 'idle';
}

export function supportsAnswerOnly(policies: unknown): boolean {
  const parsed = DerivationPolicy.array().safeParse(policies);
  return parsed.success && parsed.data.includes('answer_only');
}

function isLiveRun(run: RunSnapshot): boolean {
  return run.phase !== 'completed' && run.phase !== 'failed';
}

/** The visit's own fresh list (null while closed or before the visit's read lands). */
export function visitFreshSessions(s: CompanionState): CopilotSessionsResponse | null {
  return s.visit.open ? s.freshSessions : null;
}

export function visibleSessions(s: CompanionState): CopilotSession[] {
  const listed = s.retainedSessions;
  const optimistic = s.optimisticSession;
  return optimistic && !listed.some((session) => session.id === optimistic.id)
    ? [optimistic, ...listed]
    : listed;
}

export function selectedSession(s: CompanionState): CopilotSession | undefined {
  return visibleSessions(s).find((session) => session.id === s.currentSessionId);
}

export function isRecoveringSession(s: CompanionState, sessionId: string | null): boolean {
  return (
    s.pendingTurns.some((turn) => turn.requestBody.session_id === sessionId) ||
    s.runs.some((run) => run.sessionId === sessionId && isLiveRun(run))
  );
}

export function selectionValidated(s: CompanionState): boolean {
  if (s.selectionOrigin !== 'automatic') return true;
  if (isRecoveringSession(s, s.currentSessionId)) return true;
  const fresh = visitFreshSessions(s);
  if (!fresh) return false;
  const automatic =
    fresh.sessions.find((session) => session.id === s.currentSessionId) ??
    (s.automaticCreatedEpoch === s.visit.epoch ? s.optimisticSession : null);
  return Boolean(automatic && isReusableSession(automatic, new Date(fresh.server_time)));
}

export function conversationReady(s: CompanionState): boolean {
  return !s.creatingSession && selectionValidated(s) && isContinuable(selectedSession(s));
}

export function policySupport(s: CompanionState): PolicySupport {
  const fresh = visitFreshSessions(s);
  const check = s.policyCheck;
  if (
    check &&
    (check.result === 'checking' || (check.epoch === s.visit.epoch && check.fresh === fresh))
  )
    return check.result;
  if (fresh)
    return supportsAnswerOnly(fresh.supported_derivation_policies) ? 'supported' : 'unsupported';
  return s.sessionsStatus === 'error' ? 'unsupported' : 'checking';
}

export function currentRuns(s: CompanionState): RunSnapshot[] {
  return s.runs.filter((run) => run.sessionId === s.currentSessionId && isLiveRun(run));
}

export function currentPendingTurns(s: CompanionState): PendingTurn[] {
  return s.pendingTurns.filter((turn) => turn.requestBody.session_id === s.currentSessionId);
}

/** Something is in flight for the shown conversation (drives the 「在想…」 status). */
export function isThinking(s: CompanionState): boolean {
  return (
    s.pendingTurns.some(
      (turn) => turn.requestBody.session_id === s.currentSessionId && turn.dispatching,
    ) || currentRuns(s).length > 0
  );
}
