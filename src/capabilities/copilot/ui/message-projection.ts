import { parseCopilotPrimaryView } from '../primary-view-contract';
import type { ReplayChatMessage, ReplaySkillContext, ReplayTurn } from './replay';
import { parseSkillContext, parseSkillTurn } from './skill-lifecycle';
import type { CopilotRunView, CopilotSubtaskView, CopilotToolCallRecord } from './subtask-events';

export type ToolCallRecord = CopilotToolCallRecord;

export interface ChatMessage extends Omit<ReplayChatMessage, 'tool_calls'> {
  streaming?: boolean;
  subtasks?: CopilotSubtaskView[];
  tool_calls?: ToolCallRecord[];
  /** Client-only stable correlation for an accepted server-owned run. */
  run_id?: string;
  /** Client-only correlation while the 202 boundary is still ambiguous. */
  idempotency_key?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function settleTools(
  calls: ToolCallRecord[] | undefined,
  failed: boolean,
): ToolCallRecord[] | undefined {
  return calls?.map((call) =>
    call.status === 'running' ? { ...call, status: failed ? 'failed' : 'done' } : call,
  );
}

/** One terminal presentation policy shared by live durable events and persisted replay. */
export function projectCopilotReply(
  previous: ChatMessage,
  payload: unknown,
  context?: ReplaySkillContext,
  failed = false,
): ChatMessage | null {
  const reply = record(payload);
  if (!reply || typeof reply.reply !== 'string' || !reply.reply.trim()) return null;
  const incomplete = failed || Boolean(text(reply.error));
  return {
    ...previous,
    text: reply.reply,
    streaming: false,
    checkpoint_event_id: text(reply.checkpoint_event_id),
    session_id: text(reply.session_id) ?? previous.session_id,
    reply_event_id: text(reply.reply_event_id),
    skill_turn: incomplete ? undefined : parseSkillTurn(reply.skill_turn),
    skill_context: parseSkillContext(reply.skill_context) ?? context,
    primary_view: incomplete ? undefined : parseCopilotPrimaryView(reply.primary_view),
    ...(previous.tool_calls ? { tool_calls: settleTools(previous.tool_calls, incomplete) } : {}),
  };
}

export function projectDurableCopilotMessage(
  previous: ChatMessage,
  view: CopilotRunView,
  fallbackText: string,
): ChatMessage | null {
  // Deltas are provisional; DONE metadata alone cannot certify their contents.
  const terminalText = text(view.replyPayload?.reply_md);
  if (view.phase === 'completed' && !terminalText?.trim()) return null;
  const terminal = view.phase === 'completed' || view.phase === 'failed';
  const base = {
    ...previous,
    subtasks: view.subtasks,
    ...(view.toolCalls && view.toolCalls.length > 0 ? { tool_calls: view.toolCalls } : {}),
  };
  if (!terminal)
    return { ...base, text: view.replyText || fallbackText || previous.text, streaming: true };
  const reply = projectCopilotReply(
    base,
    {
      ...view.replyPayload,
      reply: view.phase === 'completed' ? terminalText : view.replyText || fallbackText,
      checkpoint_event_id:
        view.failureReason === 'ambiguous_execution'
          ? undefined
          : (view.checkpointEventId ?? previous.checkpoint_event_id),
    },
    undefined,
    view.phase === 'failed',
  );
  return reply ?? { ...base, text: fallbackText, streaming: false };
}

export function copilotRunReplyMessageId(runId: string): string {
  return `copilot-run-reply:${runId}`;
}

export interface PendingCopilotMessagePair {
  idempotencyKey: string;
  sessionId: string;
  userMessageId: string;
  aiMessageId: string;
  userMessage: string;
  dispatching?: boolean;
}

/** Add or restore one exact pre-202 logical turn without duplicating its rows. */
export function projectPendingCopilotMessagePair(
  messages: ChatMessage[],
  pending: PendingCopilotMessagePair,
): ChatMessage[] {
  const user: ChatMessage = {
    id: pending.userMessageId,
    role: 'user',
    text: pending.userMessage,
    session_id: pending.sessionId,
    idempotency_key: pending.idempotencyKey,
  };
  const ai: ChatMessage = {
    id: pending.aiMessageId,
    role: 'ai',
    text: pending.dispatching === false ? '受理状态暂时无法确认。' : '正在确认这次请求是否已受理。',
    streaming: pending.dispatching !== false,
    session_id: pending.sessionId,
    idempotency_key: pending.idempotencyKey,
  };
  return upsertCopilotMessage(upsertCopilotMessage(messages, user), ai);
}

/** Replace one optimistic pair with the stable run/user identities from 202. */
export function acceptPendingCopilotRun(
  messages: ChatMessage[],
  accepted: { idempotencyKey: string; sessionId: string; runId: string },
): ChatMessage[] {
  const replyId = copilotRunReplyMessageId(accepted.runId);
  const hasPersistedReply = messages.some(
    (message) =>
      message.role === 'ai' &&
      message.run_id === accepted.runId &&
      message.idempotency_key !== accepted.idempotencyKey,
  );
  const mapped = messages.flatMap((message): ChatMessage[] => {
    if (message.idempotency_key !== accepted.idempotencyKey) return [message];
    if (message.role === 'ai' && hasPersistedReply) return [];
    return [
      message.role === 'user'
        ? {
            ...message,
            id: accepted.runId,
            session_id: accepted.sessionId,
            run_id: accepted.runId,
            idempotency_key: undefined,
          }
        : {
            ...message,
            id: replyId,
            session_id: accepted.sessionId,
            run_id: accepted.runId,
            idempotency_key: undefined,
          },
    ];
  });
  const seen = new Set<string>();
  return mapped.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

/** Project one independently subscribed run into its own stable AI row. */
export function projectCopilotRunUpdate(
  messages: ChatMessage[],
  run: {
    runId: string;
    sessionId: string;
    view: CopilotRunView;
    fallbackText: string;
    userMessage?: string;
  },
): ChatMessage[] {
  let next = messages;
  if (!next.some((message) => message.role === 'user' && message.id === run.runId)) {
    next = [
      ...next,
      {
        id: run.runId,
        role: 'user',
        text: run.userMessage ?? '（已恢复的请求）',
        session_id: run.sessionId,
        run_id: run.runId,
      },
    ];
  }
  const aiMessageId = copilotRunReplyMessageId(run.runId);
  const existingReply = next.find(
    (message) => message.role === 'ai' && message.run_id === run.runId,
  );
  const previous = existingReply ?? {
    id: aiMessageId,
    role: 'ai' as const,
    text: '',
    session_id: run.sessionId,
    run_id: run.runId,
  };
  // A replayed non-synthetic reply is already authoritative. A same-key 202
  // recovered after refresh may initially report QUEUED before its event replay;
  // do not replace the persisted answer with that provisional stage.
  if (existingReply && existingReply.id !== aiMessageId && run.view.phase !== 'completed') {
    return next;
  }
  const projected = projectDurableCopilotMessage(previous, run.view, run.fallbackText);
  if (projected) return upsertCopilotMessage(next, projected);
  if (run.view.phase !== 'completed') return next;
  return upsertCopilotMessage(next, {
    ...previous,
    text: '这次请求已结束，但回复暂时不可用。',
    streaming: false,
    subtasks: run.view.subtasks,
    ...(run.view.toolCalls
      ? {
          tool_calls: run.view.toolCalls.map((call) =>
            call.status === 'running' ? { ...call, status: 'failed' as const } : call,
          ),
        }
      : {}),
  });
}

/**
 * Replace persisted history while retaining only client rows that still have a
 * concrete pending key or run handle. A run reply from history wins over its
 * live placeholder by causal run identity.
 */
export function reconcileCopilotSnapshotMessages(
  previous: ChatMessage[],
  replayed: ChatMessage[],
  sessionId: string,
  retainedRunIds: ReadonlySet<string>,
): ChatMessage[] {
  const persistedReplyRuns = new Set(
    replayed
      .filter((message) => message.role === 'ai' && message.run_id !== undefined)
      .map((message) => message.run_id as string),
  );
  const transientRunMessages = previous.filter(
    (message) =>
      message.session_id === sessionId &&
      message.run_id !== undefined &&
      retainedRunIds.has(message.run_id) &&
      !persistedReplyRuns.has(message.run_id),
  );
  const pendingMessages = previous.filter(
    (message) => message.session_id === sessionId && message.idempotency_key !== undefined,
  );
  const transientAiByRun = new Map(
    transientRunMessages
      .filter((message) => message.role === 'ai' && message.run_id)
      .map((message) => [message.run_id as string, message]),
  );
  const output: ChatMessage[] = [];
  const seenIds = new Set<string>();
  const append = (message: ChatMessage) => {
    if (seenIds.has(message.id)) return;
    seenIds.add(message.id);
    output.push(message);
  };
  for (const message of replayed) {
    append(message);
    if (message.role === 'user') {
      const liveReply = transientAiByRun.get(message.id);
      if (liveReply) append(liveReply);
    }
  }
  for (const message of transientRunMessages) append(message);
  for (const message of pendingMessages) append(message);
  return output;
}

/** Replay owns ordering/deduplication; reply presentation uses the same terminal policy. */
export function projectReplayMessage(turn: ReplayTurn): ReplayChatMessage | null {
  const previous: ChatMessage = {
    id: turn.event_id,
    role: turn.role,
    text: turn.text,
    tool_calls: turn.tool_calls,
    tool_operations: turn.tool_operations,
    subagent_runs: turn.subagent_runs,
    run_id: turn.run_id,
  };
  if (turn.role === 'tombstone')
    return {
      id: turn.event_id,
      role: 'tombstone',
      text: turn.text || '本轮更改已撤回',
      checkpoint_event_id: turn.checkpoint_event_id ?? turn.event_id,
    };
  if (typeof turn.text !== 'string' || !turn.text.trim()) return null;
  const message = projectCopilotReply(previous, { ...turn, reply: turn.text });
  if (!message) return null;
  const { streaming: _streaming, subtasks: _subtasks, tool_calls: _toolCalls, ...rest } = message;
  return { ...rest, tool_calls: turn.tool_calls };
}

export function upsertCopilotMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => (message.id === next.id ? next : message))
    : [...messages, next];
}
