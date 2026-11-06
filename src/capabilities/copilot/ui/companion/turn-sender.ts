import {
  ConfirmationCommand,
  type ConfirmationCommandT,
  type ConfirmationOccurrenceT,
} from '../../confirmation-contract';
// Sending a turn. POST /api/copilot/chat only accepts (202 + events Location); the server owns the
// run. Until the 202 is known the exact key + body are kept in sessionStorage, and a recovery
// replays that same tuple (same Idempotency-Key, same body, same message ids), so it can only ever
// find the original run, never start a second one. That makes the replay both the check and the
// resend, so it runs by itself a few times; the learner is asked only when those run out, or when
// the message is too old to send behind their back.

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
import {
  type PendingTurn,
  conversationReady,
  selectionValidated,
  supportsAnswerOnly,
} from './companion-state';
import {
  ACCEPTANCE_UNKNOWN_COPY,
  ANSWER_ONLY_UNAVAILABLE_COPY,
  plainSendError,
} from './plain-errors';

export type ConfirmationAction =
  | { kind: 'accept' | 'decline' | 'defer' | 'request_again' }
  | Pick<
      Extract<ConfirmationCommandT, { kind: 'submit' }>,
      'kind' | 'response_set' | 'group_evidence'
    >;

export interface TurnSender {
  sendConfirmation: (
    occurrence: ConfirmationOccurrenceT,
    action: ConfirmationAction,
  ) => Promise<void>;
  send: (raw: string, recovery?: PersistedPendingCopilotTurn) => Promise<void>;
  sendQuiz: (text: string, knowledgeId: string | null) => void;
  retryPendingTurn: (idempotencyKey: string) => void;
  discardPendingRecovery: (idempotencyKey: string) => void;
  /** A good read says the network is back: replay recent messages not known to have arrived. */
  resendDoubtful: () => void;
  pendingMessagesForSession: (sessionId: string) => ChatMessage[];
}

/** Waits before each automatic replay, about half a minute in all. */
const AUTO_RESEND_DELAYS_MS = [1_000, 3_000, 8_000, 20_000];
const AUTO_RESEND_MAX_AGE_MS = 10 * 60_000;
/** A read can succeed while sends still fail: start another round at most this often. */
const RESUME_RESEND_GAP_MS = 60_000;

export function canResendUnasked(turn: PersistedPendingCopilotTurn): boolean {
  return (
    !turn.refused && turn.sentAt !== undefined && Date.now() - turn.sentAt <= AUTO_RESEND_MAX_AGE_MS
  );
}

export function createTurnSender(ctx: CompanionCtx): TurnSender {
  const { internals } = ctx;
  /** Automatic replays already spent per message; a learner's own 再发一次 starts over. */
  const autoResends = new Map<string, number>();
  const lastResumeAt = new Map<string, number>();

  const setPending = (fn: (previous: PendingTurn[]) => PendingTurn[]) =>
    ctx.set({ pendingTurns: fn(ctx.get().pendingTurns) });
  const markPending = (key: string, patch: Partial<PendingTurn>) =>
    setPending((previous) =>
      previous.map((t) => (t.idempotencyKey === key ? { ...t, ...patch } : t)),
    );
  const dropPending = (key: string) => {
    autoResends.delete(key);
    lastResumeAt.delete(key);
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
  const stopReplyRow = (key: string) =>
    ctx.updateMessages((previous) =>
      previous.map((m) =>
        m.idempotency_key === key && m.role === 'ai' ? { ...m, text: '', streaming: false } : m,
      ),
    );

  async function confirmAnswerOnly(
    key: string,
    recovery: boolean,
    sessionId: string,
  ): Promise<boolean> {
    if (internals.checkingPolicy) {
      if (recovery) {
        markPending(key, { dispatching: false, doubtful: true, error: ACCEPTANCE_UNKNOWN_COPY });
        stopReplyRow(key);
      }
      return false;
    }
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
      if (!recovery || ctx.get().currentSessionId === sessionId) {
        ctx.set({ error: ANSWER_ONLY_UNAVAILABLE_COPY });
      }
      if (recovery) {
        markPending(key, { dispatching: false, error: ANSWER_ONLY_UNAVAILABLE_COPY });
        stopReplyRow(key);
      }
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

  async function send(
    raw: string,
    recovery?: PersistedPendingCopilotTurn,
    explicit?: {
      occurrence: ConfirmationOccurrenceT;
      command: ConfirmationCommandT;
      onRefused(copy: string): void;
    },
  ) {
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
    const requestBody =
      recovery?.requestBody ??
      (explicit
        ? {
            ...buildBody(sessionId, text),
            correction_target_turn_id: undefined,
            skill_context: {
              skill: 'teaching' as const,
              ref: { kind: 'learning_item', id: explicit.occurrence.learning_item_id },
            },
            confirmation: explicit.command,
          }
        : buildBody(sessionId, text));
    if (requestBody.derivation_policy === 'answer_only') {
      if (!(await confirmAnswerOnly(key, Boolean(recovery), sessionId))) return;
    }
    const pending: PendingTurn = {
      v: 2,
      idempotencyKey: key,
      userMessageId,
      aiMessageId,
      userMessage: text,
      requestBody,
      ...(recovery ? (recovery.sentAt ? { sentAt: recovery.sentAt } : {}) : { sentAt: Date.now() }),
      dispatching: true,
    };
    persistPendingCopilotTurn(pending);
    setPending((previous) =>
      previous.some((t) => t.idempotencyKey === key)
        ? previous.map((t) => (t.idempotencyKey === key ? pending : t))
        : [...previous, pending],
    );
    // A replay may belong to a conversation the learner has left: it still goes out, but the screen
    // and the state of the conversation in front of them stay as they are.
    const showing = () => ctx.get().currentSessionId === sessionId;
    const s = ctx.get();
    if (!recovery) {
      ctx.set({
        error: null,
        refreshFailed: false,
        correctionTarget: null,
        ...(!explicit && s.draft === raw ? { draft: '' } : {}),
      });
    } else if (showing()) {
      ctx.set({ error: null, refreshFailed: false });
    }
    if (showing()) {
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
    }
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
      // A first send refused by these never arrived. A replay may be refused while the first send
      // is still landing, so it keeps its key: a new key could start a second run.
      const replayMayStillLand =
        Boolean(recovery) &&
        cause instanceof ApiError &&
        (cause.status === 429 || cause.status >= 500);
      const acceptanceUnknown =
        (!(cause instanceof ApiError) && !(cause instanceof ApiAuthError)) ||
        (cause instanceof ApiError && cause.code === 'copilot_enqueue_ambiguous') ||
        replayMayStillLand;
      const authFailed =
        cause instanceof ApiAuthError ||
        (cause instanceof ApiError && (cause.status === 401 || cause.status === 403));
      if (recovery && authFailed) {
        // Keep it through signing in again: the words are still only here.
        markPending(key, { dispatching: false, doubtful: true, error: plainSendError(cause) });
        stopReplyRow(key);
        return;
      }
      if (acceptanceUnknown) {
        // Keep the exact tuple: a replay can only find the original run or start this one.
        const spent = autoResends.get(key) ?? 0;
        const delay = canResendUnasked(pending) ? AUTO_RESEND_DELAYS_MS[spent] : undefined;
        if (delay !== undefined) {
          autoResends.set(key, spent + 1);
          setTimeout(() => {
            const latest = ctx.get().pendingTurns.find((t) => t.idempotencyKey === key);
            if (latest) void send(latest.userMessage, latest, explicit);
          }, delay);
          return;
        }
        // The footer notice asks; the AI row stays empty rather than voicing it.
        markPending(key, { dispatching: false, doubtful: true, error: ACCEPTANCE_UNKNOWN_COPY });
        stopReplyRow(key);
        return;
      }
      // A definite refusal: nothing was accepted, so the tuple is no longer needed.
      const copy = plainSendError(cause);
      explicit?.onRefused(copy);
      // Refused words go back to the composer. When they cannot (another conversation, or the
      // learner typed more), the message stays for 再发一次 / 算了, and a reload does not resend it.
      const wordsCanReturn =
        !explicit && !requestBody.confirmation && showing() && ctx.get().draft === '';
      if (!explicit && !requestBody.confirmation && !wordsCanReturn) {
        persistPendingCopilotTurn({ ...pending, refused: true });
        markPending(key, { dispatching: false, refused: true, error: copy });
        stopReplyRow(key);
        return;
      }
      dropPending(key);
      // Nothing was accepted, so there is no reply row; the error notice below carries the copy.
      ctx.updateMessages((previous) =>
        previous.flatMap((m) => {
          if (m.idempotency_key !== key) return [m];
          if (m.role === 'ai') return [];
          return [{ ...m, idempotency_key: undefined, derivation_policy: undefined }];
        }),
      );
      // Nothing was sent: give the words back to the composer unless the learner already typed more.
      if (showing()) {
        ctx.set({
          refreshFailed: false,
          error: copy,
          ...(wordsCanReturn ? { draft: raw } : {}),
        });
      }
      ctx.sessions.revalidateAutomaticSelection();
    }
  }

  async function sendConfirmation(occurrence: ConfirmationOccurrenceT, action: ConfirmationAction) {
    const state = ctx.get();
    if (
      state.currentSessionId !== occurrence.session_id ||
      state.derivationPolicy !== 'allow' ||
      !conversationReady(state) ||
      state.correctionTarget
    ) {
      throw new Error('当前对话不能执行确认题动作，请先刷新对话。');
    }
    if (
      state.pendingTurns.some(
        (t) => t.requestBody.confirmation?.occurrence_id === occurrence.occurrence_id,
      ) ||
      state.runs.some(
        (r) =>
          r.sessionId === occurrence.session_id && r.phase !== 'completed' && r.phase !== 'failed',
      )
    )
      throw new Error('已有动作正在接纳或执行，请读取原记录。');
    let refused: string | undefined;
    const command = ConfirmationCommand.parse({
      ...action,
      version: 1,
      occurrence_id: occurrence.occurrence_id,
      command_id: randomId(),
    });
    const words = {
      accept: '接受一道确认题',
      decline: '这次不做确认题',
      defer: '稍后再做确认题',
      request_again: '请求再确认一次',
      submit: '提交这道确认题的作答',
    };
    await send(words[action.kind], undefined, {
      occurrence,
      command,
      onRefused: (copy) => {
        refused = copy;
      },
    });
    if (refused) throw new Error(refused);
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
    if (!pending || pending.dispatching) return;
    autoResends.delete(key);
    void send(pending.userMessage, pending);
  }

  function resendDoubtful() {
    const now = Date.now();
    for (const turn of ctx.get().pendingTurns) {
      if (!turn.doubtful || turn.dispatching || !canResendUnasked(turn)) continue;
      const key = turn.idempotencyKey;
      if (now - (lastResumeAt.get(key) ?? 0) < RESUME_RESEND_GAP_MS) continue;
      lastResumeAt.set(key, now);
      autoResends.delete(key);
      void send(turn.userMessage, turn);
    }
  }

  function discardPendingRecovery(key: string) {
    if (
      ctx.get().pendingTurns.some((t) => t.idempotencyKey === key && t.requestBody.confirmation)
    ) {
      ctx.set({
        error: '这道确认题的答案要发出去才算数，再发一次就好。',
      });
      return;
    }
    dropPending(key);
    ctx.updateMessages((previous) => previous.filter((m) => m.idempotency_key !== key));
    ctx.sessions.revalidateAutomaticSelection();
  }

  return {
    sendConfirmation,
    send,
    sendQuiz,
    retryPendingTurn,
    resendDoubtful,
    discardPendingRecovery,
    pendingMessagesForSession,
  };
}
