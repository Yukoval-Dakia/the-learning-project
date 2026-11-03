import { DerivationPolicy, type DerivationPolicyT } from '@/core/schema/derivation-policy';
import { parseCopilotPrimaryView } from '../primary-view-contract';
import { parseConfirmation } from './confirmation';
import { mergePublicProse, parsePublicProse } from './public-prose';
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
  if (!reply || typeof reply.reply !== 'string') return null;
  const publicProse = parsePublicProse(reply.public_prose);
  const interrupted = publicProse?.status === 'failed' || publicProse?.status === 'interrupted';
  if (!reply.reply.trim() && !interrupted && publicProse?.status !== 'streaming') return null;
  const incomplete =
    failed || interrupted || publicProse?.status === 'streaming' || Boolean(text(reply.error));
  return {
    ...previous,
    text: reply.reply,
    confirmation:
      reply.confirmation === undefined
        ? previous.confirmation
        : parseConfirmation(reply.confirmation),
    confirmationIncompatible:
      reply.confirmation !== undefined && !parseConfirmation(reply.confirmation),
    public_prose: publicProse,
    derivation_policy:
      DerivationPolicy.safeParse(reply.derivation_policy).data ?? previous.derivation_policy,
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

/**
 * The AI row carries only real reply text. While nothing has arrived it stays empty and the row's
 * own "正在回复" line plus the run footer show the state; engineering status never becomes the
 * model's words.
 */
export function projectDurableCopilotMessage(
  previous: ChatMessage,
  view: CopilotRunView,
): ChatMessage | null {
  // Deltas are provisional; DONE metadata alone cannot certify their contents.
  const terminalText = text(view.replyPayload?.reply_md);
  if (view.phase === 'completed' && !terminalText?.trim()) return null;
  const terminal = view.phase === 'completed' || view.phase === 'failed';
  // A turns snapshot can precede its SSE backlog. Preserve its covered prefix and
  // append only later durable deltas from this run's already-deduplicated view.
  const snapshot = previous.public_prose;
  const publicProse =
    view.publicProse ??
    (!terminal && snapshot?.status === 'streaming'
      ? mergePublicProse(
          snapshot,
          new Map(
            view.frames
              .filter(
                (frame) =>
                  frame.event_type === 'copilot_run.delta' &&
                  typeof frame.payload.text === 'string',
              )
              .map((frame) => [frame.event_id, frame.payload.text as string]),
          ),
        )
      : undefined);
  const base = {
    ...previous,
    subtasks: view.subtasks,
    public_prose: publicProse,
    ...(view.toolCalls && view.toolCalls.length > 0 ? { tool_calls: view.toolCalls } : {}),
  };
  if (!terminal) return { ...base, text: view.replyText || previous.text, streaming: true };
  const reply = projectCopilotReply(
    base,
    {
      ...view.replyPayload,
      public_prose: publicProse,
      reply: view.phase === 'completed' ? terminalText : view.replyText,
      checkpoint_event_id:
        view.failureReason === 'ambiguous_execution'
          ? undefined
          : (view.checkpointEventId ?? previous.checkpoint_event_id),
    },
    undefined,
    view.phase === 'failed',
  );
  // A failed run with neither text nor a public failure status (legacy rows): state the outcome.
  return reply ?? { ...base, text: '这次没有完成回答。', streaming: false };
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
  derivationPolicy?: DerivationPolicyT;
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
    derivation_policy: pending.derivationPolicy ?? 'allow',
  };
  const ai: ChatMessage = {
    id: pending.aiMessageId,
    role: 'ai',
    // No status words in the AI row: while sending, the row's own "正在回复" line is the only
    // indicator; an unconfirmed delivery is stated (with 恢复) by the footer notice.
    text: '',
    streaming: pending.dispatching !== false,
    session_id: pending.sessionId,
    idempotency_key: pending.idempotencyKey,
    derivation_policy: pending.derivationPolicy ?? 'allow',
  };
  return upsertCopilotMessage(upsertCopilotMessage(messages, user), ai);
}

/** Replace one optimistic pair with the stable run/user identities from 202. */
export function acceptPendingCopilotRun(
  messages: ChatMessage[],
  accepted: {
    idempotencyKey: string;
    sessionId: string;
    runId: string;
    derivationPolicy?: DerivationPolicyT;
  },
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
            derivation_policy: accepted.derivationPolicy ?? message.derivation_policy,
          }
        : {
            ...message,
            id: replyId,
            session_id: accepted.sessionId,
            run_id: accepted.runId,
            idempotency_key: undefined,
            derivation_policy: accepted.derivationPolicy ?? message.derivation_policy,
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
    userMessage?: string;
    derivationPolicy?: DerivationPolicyT;
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
        derivation_policy: run.derivationPolicy ?? 'allow',
      },
    ];
  }
  const aiMessageId = copilotRunReplyMessageId(run.runId);
  const existingReply = next.find(
    (message) =>
      message.role === 'ai' && message.run_id === run.runId && message.session_id === run.sessionId,
  );
  const previous = existingReply ?? {
    id: aiMessageId,
    role: 'ai' as const,
    text: '',
    session_id: run.sessionId,
    run_id: run.runId,
    derivation_policy: run.derivationPolicy ?? 'allow',
  };
  const publicSnapshot =
    existingReply &&
    existingReply.id === `copilot_public_prose_${run.runId}` &&
    existingReply.public_prose !== undefined &&
    existingReply.reply_event_id === undefined &&
    existingReply.checkpoint_event_id === undefined;
  // A terminal snapshot must not regress while its SSE backlog reconnects.
  if (
    publicSnapshot &&
    existingReply.public_prose?.status !== 'streaming' &&
    run.view.phase !== 'completed' &&
    run.view.phase !== 'failed'
  )
    return next;
  // A replayed non-synthetic reply is already authoritative. A same-key 202
  // recovered after refresh may initially report QUEUED before its event replay;
  // do not replace the persisted answer with that provisional stage.
  if (
    existingReply &&
    !publicSnapshot &&
    existingReply.id !== aiMessageId &&
    run.view.phase !== 'completed'
  ) {
    return next;
  }
  const projected = projectDurableCopilotMessage(previous, run.view);
  if (projected) return upsertCopilotMessage(next, projected);
  if (run.view.phase !== 'completed') return next;
  return upsertCopilotMessage(next, {
    ...previous,
    text: '这次请求已结束，但回复暂时不可用。',
    public_prose: undefined,
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
    derivation_policy: turn.derivation_policy,
  };
  if (turn.role === 'tombstone')
    return {
      id: turn.event_id,
      role: 'tombstone',
      text: turn.text || '本轮更改已撤回',
      checkpoint_event_id: turn.checkpoint_event_id,
    };
  if (typeof turn.text !== 'string') return null;
  const publicProse = parsePublicProse(turn.public_prose);
  if (turn.role === 'ai' && publicProse?.status === 'completed' && !turn.text.trim()) {
    return {
      id: turn.event_id,
      role: 'ai',
      run_id: turn.run_id,
      session_id: turn.session_id,
      derivation_policy: turn.derivation_policy,
      text: '成功回复正文缺失，暂时无法恢复完整回答。',
      tool_calls: turn.tool_calls,
      tool_operations: turn.tool_operations,
      subagent_runs: turn.subagent_runs,
    };
  }
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
