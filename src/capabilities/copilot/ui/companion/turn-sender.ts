// Sending a turn. POST /api/copilot/chat only accepts (202 + events Location); the server owns the
// run. Until the 202 is known the exact key + body are kept in sessionStorage, and a recovery
// replays that same tuple (same Idempotency-Key, same body, same message ids), so it can only ever
// find the original run, never start a second one. Nothing auto-retries: the learner chooses 恢复.

import { ApiAuthError, ApiError } from '@/ui/lib/api';
import { randomId } from '@/ui/lib/random-id';
import { readCompanionFocus } from '@/ui/lib/use-copilot-dwell';
import {
  type PersistedPendingCopilotRequestBody,
  type PersistedPendingCopilotTurn,
  clearPersistedPendingCopilotTurn,
  persistPendingCopilotTurn,
} from '../durable-reconnect-storage';
import {
  type ChatMessage,
  acceptPendingCopilotRun,
  projectPendingCopilotMessagePair,
} from '../message-projection';
import { resolveTurnAmbientFocus } from '../nudge-focus';
import { readAcceptance } from './acceptance';
import { type CompanionCtx, nextMessageId } from './companion-context';
import { type PendingTurn, selectionValidated, supportsAnswerOnly } from './companion-state';
import {
  ACCEPTANCE_UNKNOWN_COPY,
  ANSWER_ONLY_UNAVAILABLE_COPY,
  plainSendError,
} from './plain-errors';

export interface TurnSender {
  send: (raw: string, recovery?: PersistedPendingCopilotTurn) => Promise<void>;
  sendQuiz: (text: string, knowledgeId: string | null) => void;
  retryPendingTurn: (idempotencyKey: string) => void;
  discardPendingRecovery: (idempotencyKey: string) => void;
  pendingMessagesForSession: (sessionId: string) => ChatMessage[];
}

export function createTurnSender(ctx: CompanionCtx): TurnSender {
  const { internals } = ctx;

  const setPending = (fn: (previous: PendingTurn[]) => PendingTurn[]) =>
    ctx.set({ pendingTurns: fn(ctx.get().pendingTurns) });
  const markPending = (key: string, patch: Partial<PendingTurn>) =>
    setPending((previous) =>
      previous.map((t) => (t.idempotencyKey === key ? { ...t, ...patch } : t)),
    );
  const dropPending = (key: string) => {
    clearPersistedPendingCopilotTurn(key);
    setPending((previous) => previous.filter((t) => t.idempotencyKey !== key));
  };

  function pendingMessagesForSession(sessionId: string): ChatMessage[] {
    return ctx
      .get()
      .pendingTurns.filter((turn) => turn.requestBody.session_id === sessionId)
      .reduce<ChatMessage[]>(
        (current, turn) =>
          projectPendingCopilotMessagePair(current, {
            idempotencyKey: turn.idempotencyKey,
            sessionId,
            userMessageId: turn.userMessageId,
            aiMessageId: turn.aiMessageId,
            userMessage: turn.userMessage,
            derivationPolicy: turn.requestBody.derivation_policy ?? 'allow',
            dispatching: turn.dispatching,
          }),
        [],
      );
  }

  /** A fresh read before every restricted dispatch; an earlier list never authorizes it. */
  async function confirmAnswerOnly(key: string, recovery: boolean): Promise<boolean> {
    if (internals.checkingPolicy) return false;
    internals.checkingPolicy = true;
    const record = (result: 'checking' | 'supported' | 'unsupported') =>
      ctx.set({
        policyCheck: {
          result,
          epoch: ctx.get().visit.epoch,
          fresh: ctx.sessions.currentFreshSessions(),
        },
      });
    record('checking');
    try {
      const current = await ctx.client.listSessions();
      if (!supportsAnswerOnly(current.supported_derivation_policies))
        throw new Error('unsupported');
      record('supported');
      return true;
    } catch {
      record('unsupported');
      ctx.set({ error: ANSWER_ONLY_UNAVAILABLE_COPY });
      if (recovery) markPending(key, { dispatching: false, error: ANSWER_ONLY_UNAVAILABLE_COPY });
      return false;
    } finally {
      internals.checkingPolicy = false;
    }
  }

  function buildBody(sessionId: string, text: string): PersistedPendingCopilotRequestBody {
    const s = ctx.get();
    const correction = s.correctionTarget;
    const skill = correction ? null : internals.activeSkill;
    // Route and page focus are read now, at send time. A recovery replays the stored body
    // instead: recomputing would make the server reject the original key with a 409.
    const route = typeof window === 'undefined' ? '' : window.location.pathname;
    const page = readCompanionFocus();
    // An active skill wins, then a nudge's material (one-shot), then what the page shows.
    const focus =
      resolveTurnAmbientFocus(skill?.ref, internals.nudgeSession) ??
      (page ? { kind: page.kind, id: page.id } : undefined);
    return {
      session_id: sessionId,
      user_message: text,
      derivation_policy: s.derivationPolicy,
      triggered_by: 'chat' as const,
      ...(skill && s.derivationPolicy === 'allow' ? { skill_context: skill } : {}),
      ...(route ? { ambient_context: { route, ...(focus ? { focused_entity: focus } : {}) } } : {}),
      ...(correction ? { correction_target_turn_id: correction.turnId } : {}),
    };
  }

  async function send(raw: string, recovery?: PersistedPendingCopilotTurn) {
    const text = recovery?.userMessage ?? raw.trim();
    const sessionId = recovery?.requestBody.session_id ?? ctx.get().currentSessionId;
    if (!text || (!recovery && !selectionValidated(ctx.get()))) return;
    if (!sessionId) {
      ctx.set({ error: '对话还在加载，稍后再试。' });
      return;
    }
    const key = recovery?.idempotencyKey ?? randomId();
    const userMessageId = recovery?.userMessageId ?? nextMessageId();
    const aiMessageId = recovery?.aiMessageId ?? nextMessageId();
    const requestBody = recovery?.requestBody ?? buildBody(sessionId, text);
    if (requestBody.derivation_policy === 'answer_only') {
      if (!(await confirmAnswerOnly(key, Boolean(recovery)))) return;
    }
    const pending: PendingTurn = {
      v: 2,
      idempotencyKey: key,
      userMessageId,
      aiMessageId,
      userMessage: text,
      requestBody,
      dispatching: true,
    };
    persistPendingCopilotTurn(pending);
    setPending((previous) =>
      previous.some((t) => t.idempotencyKey === key)
        ? previous.map((t) => (t.idempotencyKey === key ? pending : t))
        : [...previous, pending],
    );
    const s = ctx.get();
    ctx.set({
      error: null,
      refreshFailed: false,
      correctionTarget: null,
      ...(!recovery && s.draft === raw ? { draft: '' } : {}),
    });
    ctx.updateMessages((previous) =>
      projectPendingCopilotMessagePair(previous, {
        idempotencyKey: key,
        sessionId,
        userMessageId,
        aiMessageId,
        userMessage: text,
        derivationPolicy: requestBody.derivation_policy ?? 'allow',
        dispatching: true,
      }),
    );
    try {
      const res = await ctx.client.sendChat(requestBody, key);
      const accepted = await readAcceptance(res, requestBody.derivation_policy);
      dropPending(key);
      ctx.updateMessages((previous) =>
        ctx.get().currentSessionId === sessionId
          ? acceptPendingCopilotRun(previous, {
              idempotencyKey: key,
              sessionId,
              runId: accepted.runId,
              derivationPolicy: accepted.policy,
            })
          : previous,
      );
      ctx.runs.trackAccepted({
        runId: accepted.runId,
        sessionId,
        location: accepted.location,
        userMessage: text,
        derivationPolicy: accepted.policy,
      });
      ctx.sessions.revalidateAutomaticSelection();
    } catch (cause) {
      const acceptanceUnknown =
        (!(cause instanceof ApiError) && !(cause instanceof ApiAuthError)) ||
        (cause instanceof ApiError && cause.code === 'copilot_enqueue_ambiguous');
      if (acceptanceUnknown) {
        // Keep the exact tuple: 恢复 replays it and can only find the original run.
        markPending(key, { dispatching: false, error: ACCEPTANCE_UNKNOWN_COPY });
        ctx.updateMessages((previous) =>
          previous.map((m) =>
            m.idempotency_key === key && m.role === 'ai'
              ? { ...m, text: '还不能确认这条是否已送达。', streaming: false }
              : m,
          ),
        );
        return;
      }
      // A definite refusal: nothing was accepted, so the tuple is no longer needed.
      const copy = plainSendError(cause);
      dropPending(key);
      ctx.updateMessages((previous) =>
        previous.map((m) => {
          if (m.idempotency_key !== key) return m;
          const cleared = { ...m, idempotency_key: undefined, derivation_policy: undefined };
          return m.role === 'ai' ? { ...cleared, text: copy, streaming: false } : cleared;
        }),
      );
      // Nothing was sent: give the words back to the composer unless the learner already typed more.
      ctx.set({
        refreshFailed: false,
        error: copy,
        ...(!recovery && ctx.get().draft === '' ? { draft: raw } : {}),
      });
      ctx.sessions.revalidateAutomaticSelection();
    }
  }

  function sendQuiz(text: string, knowledgeId: string | null) {
    // With a focused knowledge point the quiz skill gets that real id; without one the prompt
    // follows normal routing (and a stale teaching context is dropped) so the model can clarify.
    internals.activeSkill = knowledgeId
      ? { skill: 'quiz', ref: { kind: 'knowledge', id: knowledgeId } }
      : null;
    void send(text);
  }

  function retryPendingTurn(key: string) {
    const pending = ctx.get().pendingTurns.find((t) => t.idempotencyKey === key);
    if (pending && !pending.dispatching) void send(pending.userMessage, pending);
  }

  function discardPendingRecovery(key: string) {
    dropPending(key);
    ctx.updateMessages((previous) => previous.filter((m) => m.idempotency_key !== key));
    ctx.sessions.revalidateAutomaticSelection();
  }

  return {
    send,
    sendQuiz,
    retryPendingTurn,
    discardPendingRecovery,
    pendingMessagesForSession,
  };
}
