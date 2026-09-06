import type {
  ReplayChatMessage,
  ReplayPrimaryView,
  ReplaySkillContext,
  ReplayTurn,
} from './replay';
import { parseSkillContext, parseSkillTurn } from './skill-lifecycle';
import type { CopilotRunView, CopilotSubtaskView } from './subtask-events';

export interface ToolCallRecord {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId?: string;
  summary?: string;
  status?: 'running' | 'done' | 'failed';
  errorReason?: string;
}

export interface ChatMessage extends Omit<ReplayChatMessage, 'tool_calls'> {
  streaming?: boolean;
  subtasks?: CopilotSubtaskView[];
  tool_calls?: ToolCallRecord[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parsePrimaryView(value: unknown): ReplayPrimaryView | undefined {
  const view = record(value);
  if (!view) return undefined;
  if (view.source === 'ephemeral_html' && typeof view.ref === 'string') {
    return { source: view.source, ref: view.ref };
  }
  const ref = record(view.ref);
  if (
    (view.source === 'artifact' || view.source === 'tool_result') &&
    ref &&
    typeof ref.kind === 'string' &&
    typeof ref.id === 'string'
  ) {
    return { source: view.source, ref: { kind: ref.kind, id: ref.id } };
  }
  return undefined;
}

function settleTools(
  calls: ToolCallRecord[] | undefined,
  failed: boolean,
): ToolCallRecord[] | undefined {
  return calls?.map((call) =>
    call.status === 'running' ? { ...call, status: failed ? 'failed' : 'done' } : call,
  );
}

/** One terminal presentation policy shared by inline, durable and persisted replay. */
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
    primary_view: parsePrimaryView(reply.primary_view),
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
  const base = { ...previous, subtasks: view.subtasks };
  if (!terminal)
    return { ...base, text: view.replyText || previous.text || fallbackText, streaming: true };
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

/** Replay owns ordering/deduplication; reply presentation uses the same terminal policy. */
export function projectReplayMessage(turn: ReplayTurn): ReplayChatMessage | null {
  const previous: ChatMessage = {
    id: turn.event_id,
    role: turn.role,
    text: turn.text,
    tool_calls: turn.tool_calls,
    tool_operations: turn.tool_operations,
    subagent_runs: turn.subagent_runs,
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

function normalizeToolName(name: string): string {
  const match = /^mcp__[a-z0-9_-]+__(.+)$/i.exec(name);
  return match ? match[1] : name;
}

function parseToolUseSse(data: string): ToolCallRecord | null {
  try {
    const raw = JSON.parse(data) as {
      toolName?: unknown;
      input?: unknown;
      toolUseId?: unknown;
    };
    if (typeof raw.toolName !== 'string') return null;
    return {
      toolName: normalizeToolName(raw.toolName),
      input:
        raw.input !== null && typeof raw.input === 'object' && !Array.isArray(raw.input)
          ? (raw.input as Record<string, unknown>)
          : {},
      ...(typeof raw.toolUseId === 'string' ? { toolUseId: raw.toolUseId } : {}),
      status: 'running',
    };
  } catch {
    return null;
  }
}

function parseToolResultSse(data: string): ToolCallRecord | null {
  try {
    const raw = JSON.parse(data) as {
      toolName?: unknown;
      input?: unknown;
      summary?: unknown;
      errorReason?: unknown;
      toolUseId?: unknown;
    };
    if (typeof raw.toolName !== 'string') return null;
    const summary = typeof raw.summary === 'string' ? raw.summary : undefined;
    const errorReason =
      typeof raw.errorReason === 'string' && raw.errorReason.length > 0
        ? raw.errorReason
        : undefined;
    return {
      toolName: normalizeToolName(raw.toolName),
      input:
        raw.input !== null && typeof raw.input === 'object' && !Array.isArray(raw.input)
          ? (raw.input as Record<string, unknown>)
          : {},
      ...(typeof raw.toolUseId === 'string' ? { toolUseId: raw.toolUseId } : {}),
      ...(summary ? { summary } : {}),
      ...(errorReason ? { errorReason } : {}),
      status: errorReason ? 'failed' : 'done',
    };
  } catch {
    return null;
  }
}

/**
 * YUK-913 — fold a tool_use frame into the call list WITHOUT ever creating a
 * second card for one logical call: an id-carrying duplicate frame (same
 * toolUseId) is a no-op; an id-less duplicate while the same tool is already
 * running is treated as the same call (a second 调用中 card would strand
 * forever). A genuinely new call — distinct toolUseId, or no running same-name
 * card — appends.
 */
function mergeToolUseEvent(calls: ToolCallRecord[], call: ToolCallRecord): ToolCallRecord[] {
  if (call.toolUseId !== undefined && calls.some((c) => c.toolUseId === call.toolUseId)) {
    return calls;
  }
  if (
    call.toolUseId === undefined &&
    calls.some((c) => c.toolName === call.toolName && c.status === 'running')
  ) {
    return calls;
  }
  return [...calls, call];
}

/**
 * YUK-913 — resolve ONE running call IN PLACE (never append beside it): prefer
 * the stable toolUseId correlation; an id-less result (the current wire
 * contract) resolves the OLDEST running call of the same normalized tool name
 * (serial execution order). With no running match, the result still lands as
 * its own single terminal card (result-before-call / lost tool_use frame).
 */
function applyToolResult(calls: ToolCallRecord[], result: ToolCallRecord): ToolCallRecord[] {
  if (
    result.toolUseId !== undefined &&
    calls.some(
      (call) =>
        call.toolUseId === result.toolUseId && (call.status === 'done' || call.status === 'failed'),
    )
  ) {
    return calls;
  }
  const idx = calls.findIndex(
    (call) =>
      call.status === 'running' &&
      (result.toolUseId !== undefined
        ? call.toolUseId === result.toolUseId
        : call.toolName === result.toolName),
  );
  if (idx === -1) {
    return [...calls, result];
  }
  const next = [...calls];
  next[idx] = { ...next[idx], ...result };
  return next;
}

export function projectToolEvent(
  calls: ToolCallRecord[],
  event: 'tool_use' | 'tool_result',
  data: string,
): ToolCallRecord[] {
  const parsed = event === 'tool_use' ? parseToolUseSse(data) : parseToolResultSse(data);
  return !parsed
    ? calls
    : event === 'tool_use'
      ? mergeToolUseEvent(calls, parsed)
      : applyToolResult(calls, parsed);
}

export function upsertCopilotMessage(messages: ChatMessage[], next: ChatMessage): ChatMessage[] {
  return messages.some((message) => message.id === next.id)
    ? messages.map((message) => (message.id === next.id ? next : message))
    : [...messages, next];
}
