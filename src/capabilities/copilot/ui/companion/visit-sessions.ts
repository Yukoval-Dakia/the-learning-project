// Visits and conversation selection. One visit = one open of the companion; each visit reads a fresh
// session list, keeps a still-reusable automatic selection, else resumes the newest reusable session
// (active/idle, updated within 24 h), else creates exactly one session for the visit. Explicit and
// recovery selections are never overridden. Closing only detaches streams; it never cancels a run.

import { preloadMarkdownRenderer } from '@/ui/lib/deferred-markdown-renderer';
import type { CopilotSessionsResponse } from '../copilot-client';
import { type CompanionCtx, swallow } from './companion-context';
import {
  hasServerTime,
  isRecoveringSession,
  isReusableSession,
  visitFreshSessions,
} from './companion-state';
import { plainError } from './plain-errors';
import { RECENT_CONVERSATIONS_KEY } from './use-recent-conversations';

export interface VisitSessions {
  openVisit: () => void;
  closeVisit: () => void;
  loadVisitSessions: (epoch: number) => void;
  createConversation: (origin?: 'automatic' | 'explicit') => Promise<void>;
  selectConversation: (sessionId: string, origin?: 'automatic' | 'explicit') => void;
  revalidateAutomaticSelection: () => void;
  currentFreshSessions: () => CopilotSessionsResponse | null;
}

export function createVisitSessions(ctx: CompanionCtx): VisitSessions {
  const { internals } = ctx;
  const sessionsKey = (epoch: number) => ['copilot-sessions', ctx.instance, epoch] as const;

  const currentFreshSessions = () => visitFreshSessions(ctx.get());

  /** Read the visit's list (one cache entry per visit); the last success stays for display. */
  async function fetchVisitSessions(epoch: number): Promise<CopilotSessionsResponse> {
    try {
      const snapshot = await ctx.queryClient.fetchQuery({
        queryKey: sessionsKey(epoch),
        queryFn: ({ signal }) => ctx.client.listSessions(signal),
        staleTime: 0,
        retry: 3,
      });
      const forVisit = ctx.get().visit.epoch === epoch && hasServerTime(snapshot);
      ctx.set({
        retainedSessions: snapshot.sessions,
        ...(forVisit ? { freshSessions: snapshot, sessionsStatus: 'ready' as const } : {}),
      });
      // The shell's 最近 list reads the same response; keep it current without a second request.
      ctx.queryClient.setQueryData(RECENT_CONVERSATIONS_KEY, snapshot);
      return snapshot;
    } catch (cause) {
      if (ctx.get().visit.epoch === epoch) ctx.set({ sessionsStatus: 'error' });
      throw cause;
    }
  }

  function selectConversation(sessionId: string, origin: 'automatic' | 'explicit' = 'explicit') {
    internals.selectionRevision += 1;
    const previous = ctx.get().currentSessionId;
    if (previous && previous !== sessionId) ctx.runs.detachSubscriptions(previous);
    internals.activeSkill = null;
    ctx.set({
      selectionOrigin: origin,
      skillKnowledgeId: null,
      correctionTarget: null,
      optimisticSession: null,
      error: null,
      currentSessionId: sessionId,
    });
    ctx.updateMessages(ctx.sender.pendingMessagesForSession(sessionId));
  }

  async function createConversation(origin: 'automatic' | 'explicit' = 'explicit') {
    if (ctx.get().creatingSession) return;
    // A learner's explicit pick made while an automatic create is in flight wins; the new
    // session then only joins the list (YUK-1340).
    const selectionAtRequest = ++internals.selectionRevision;
    const epochAtRequest = ctx.get().visit.epoch;
    ctx.set({
      creatingSession: true,
      error: null,
      ...(origin === 'explicit' ? { selectionOrigin: 'explicit' as const } : {}),
    });
    try {
      const response = await ctx.client.createSession();
      const visit = ctx.get().visit;
      if (
        internals.selectionRevision === selectionAtRequest &&
        (origin === 'explicit' || (visit.open && visit.epoch === epochAtRequest))
      ) {
        const previous = ctx.get().currentSessionId;
        if (previous) ctx.runs.detachSubscriptions(previous);
        internals.activeSkill = null;
        ctx.set({
          skillKnowledgeId: null,
          correctionTarget: null,
          currentSessionId: response.session.id,
          selectionOrigin: origin,
          automaticCreatedEpoch: origin === 'automatic' ? epochAtRequest : null,
          optimisticSession: response.session,
        });
        ctx.updateMessages([]);
      }
      // Re-read so the new session is listed; once it is, an automatic pick drops its placeholder.
      void fetchVisitSessions(ctx.get().visit.epoch).then((snapshot) => {
        const s = ctx.get();
        const optimistic = s.optimisticSession;
        if (
          s.selectionOrigin === 'automatic' &&
          optimistic &&
          optimistic.id === s.currentSessionId &&
          snapshot.sessions.some((session) => session.id === optimistic.id)
        ) {
          ctx.set({ optimisticSession: null });
          internals.bootstrapEpoch = null;
        }
      }, swallow);
    } catch (cause) {
      ctx.set({ error: plainError(cause, '新对话没有建好，稍后再试。') });
    } finally {
      ctx.set({ creatingSession: false });
    }
  }

  function bootstrap(epoch: number, snapshot: CopilotSessionsResponse): void {
    const s = ctx.get();
    if (!s.visit.open || s.visit.epoch !== epoch || !hasServerTime(snapshot)) return;
    if (s.selectionOrigin !== 'automatic') return;
    const sessionId = s.currentSessionId;
    if (isRecoveringSession(s, sessionId)) return;
    const serverNow = new Date(snapshot.server_time);
    const optimistic = s.optimisticSession;
    const automaticSession =
      snapshot.sessions.find((session) => session.id === sessionId) ??
      (s.automaticCreatedEpoch === epoch ? optimistic : null);
    if (automaticSession && isReusableSession(automaticSession, serverNow)) {
      if (optimistic && snapshot.sessions.some((session) => session.id === optimistic.id)) {
        ctx.set({ optimisticSession: null });
      }
      internals.bootstrapEpoch = null;
      return;
    }
    if (s.creatingSession) return;
    const resumable = snapshot.sessions.find((session) => isReusableSession(session, serverNow));
    if (resumable) {
      internals.bootstrapEpoch = null;
      selectConversation(resumable.id, 'automatic');
      return;
    }
    if (internals.bootstrapEpoch === epoch) return;
    internals.bootstrapEpoch = epoch;
    // At most one automatic create per visit. When it settles, re-check the visit open now
    // against a list read after the create (a stale list would create an extra empty session).
    void createConversation('automatic').finally(() => {
      const current = ctx.get().visit;
      if (!current.open) return;
      void fetchVisitSessions(current.epoch).then(
        (fresh) => bootstrap(current.epoch, fresh),
        swallow,
      );
    });
  }

  function loadVisitSessions(epoch: number) {
    ctx.set({ sessionsStatus: 'loading' });
    void fetchVisitSessions(epoch).then((snapshot) => bootstrap(epoch, snapshot), swallow);
  }

  /** A recovery or pending turn ended: re-run the visit's bootstrap against its fresh list. */
  function revalidateAutomaticSelection() {
    const s = ctx.get();
    const fresh = currentFreshSessions();
    if (s.visit.open && fresh) bootstrap(s.visit.epoch, fresh);
  }

  function openVisit() {
    const visit = ctx.get().visit;
    if (visit.open) return;
    const epoch = visit.epoch + 1;
    ctx.set({ visit: { open: true, epoch }, freshSessions: null });
    preloadMarkdownRenderer();
    loadVisitSessions(epoch);
  }

  function closeVisit() {
    const visit = ctx.get().visit;
    if (!visit.open) return;
    // Unsubscribe only. Server-owned runs and queued successors keep going and are found again
    // by the next snapshot.
    ctx.runs.detachSubscriptions();
    internals.activeSkill = null;
    internals.nudgeSession = null;
    ctx.set({
      visit: { open: false, epoch: visit.epoch },
      skillKnowledgeId: null,
      correctionTarget: null,
      listOpen: false,
    });
  }

  return {
    openVisit,
    closeVisit,
    loadVisitSessions,
    createConversation,
    selectConversation,
    revalidateAutomaticSelection,
    currentFreshSessions,
  };
}
