// YUK-757 — public subtask lifecycle carrier shared by inline Copilot SSE and
// durable copilot_run job-event replay.
//
// The SDK child transcript, prompt and reasoning never cross this seam. The
// only accepted payload is a small user-facing projection: stable id, label,
// lifecycle status and an optional terminal summary/error. Durable frames use
// job_events.id as their version; inline frames receive a local monotonic id in
// CopilotDock before entering the same fold.

export const COPILOT_RUN_STEP_EVENT = 'copilot_run.step' as const;

export type CopilotSubtaskStatus = 'running' | 'completed' | 'failed';

export interface CopilotSubtaskEvent {
  step_kind: 'subtask';
  subtask_id: string;
  label: string;
  status: CopilotSubtaskStatus;
  summary?: string;
  error?: string;
}

export interface CopilotSubtaskView {
  id: string;
  label: string;
  status: CopilotSubtaskStatus;
  summary?: string;
  error?: string;
  lastEventId: number;
}

export interface CopilotRunJobFrame {
  event_id: number;
  event_type: string;
  payload: Record<string, unknown>;
}

export type CopilotRunPhase = 'queued' | 'running' | 'completed' | 'failed';

export interface CopilotRunView {
  phase: CopilotRunPhase;
  lastEventId: number;
  replyText: string;
  checkpointEventId?: string;
  subtasks: CopilotSubtaskView[];
  /** Internal replay inventory. Kept immutable so out-of-order arrivals can be re-folded. */
  frames: CopilotRunJobFrame[];
}

export interface ParsedSseEvent {
  id?: number;
  event: string;
  data: string;
}

const TERMINAL_SUBTASKS = new Set<CopilotSubtaskStatus>(['completed', 'failed']);
const TERMINAL_RUN_PHASES = new Set<CopilotRunPhase>(['completed', 'failed']);
const MAX_SUBTASK_ID_CHARS = 160;
const MAX_SUBTASK_LABEL_CHARS = 160;
const MAX_TERMINAL_COPY_CHARS = 800;
const TERMINAL_FALLBACK_LABELS = new Set(['子任务已完成', '子任务未完成']);

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length === 0 || text.length > maxChars) return undefined;
  return text;
}

/**
 * Runtime-narrow the public payload. Unknown keys are intentionally discarded,
 * which keeps transcript/reasoning/prompt/tool args out of React state even if
 * an upstream producer accidentally includes them.
 */
export function parseSubtaskPayload(value: unknown): CopilotSubtaskEvent | null {
  const payload = objectRecord(value);
  if (!payload || payload.step_kind !== 'subtask') return null;
  const subtaskId = boundedText(payload.subtask_id, MAX_SUBTASK_ID_CHARS);
  const label = boundedText(payload.label, MAX_SUBTASK_LABEL_CHARS);
  const status = payload.status;
  if (
    !subtaskId ||
    !label ||
    (status !== 'running' && status !== 'completed' && status !== 'failed')
  ) {
    return null;
  }

  const summary = boundedText(payload.summary, MAX_TERMINAL_COPY_CHARS);
  const error = boundedText(payload.error, MAX_TERMINAL_COPY_CHARS);
  return {
    step_kind: 'subtask',
    subtask_id: subtaskId,
    label,
    status,
    // Terminal fields are status-specific. A producer cannot smuggle an error
    // into a running/done card or a success summary into a failed card.
    ...(status === 'completed' && summary ? { summary } : {}),
    ...(status === 'failed' && error ? { error } : {}),
  };
}

export function parseInlineSubtaskEvent(data: string): CopilotSubtaskEvent | null {
  try {
    return parseSubtaskPayload(JSON.parse(data));
  } catch {
    return null;
  }
}

export function subtaskEventToFrame(
  payload: CopilotSubtaskEvent,
  eventId: number,
): CopilotRunJobFrame {
  return { event_id: eventId, event_type: COPILOT_RUN_STEP_EVENT, payload: { ...payload } };
}

export function parseCopilotRunJobFrame(data: string): CopilotRunJobFrame | null {
  try {
    const raw = objectRecord(JSON.parse(data));
    if (!raw) return null;
    const payload = objectRecord(raw.payload);
    if (
      !Number.isSafeInteger(raw.event_id) ||
      (raw.event_id as number) <= 0 ||
      typeof raw.event_type !== 'string' ||
      !payload
    ) {
      return null;
    }
    return {
      event_id: raw.event_id as number,
      event_type: raw.event_type,
      payload,
    };
  } catch {
    return null;
  }
}

export function createCopilotRunView(): CopilotRunView {
  return {
    phase: 'queued',
    lastEventId: 0,
    replyText: '',
    subtasks: [],
    frames: [],
  };
}

interface MutableSubtask extends CopilotSubtaskView {
  firstEventId: number;
}

/**
 * Merge + re-fold by durable event id. Re-folding (rather than merely ignoring
 * `id <= cursor`) is deliberate: tests, proxies and reconnect boundaries can
 * present frames out of array order. Exact ids are idempotent, distinct older
 * ids remain meaningful for a different subtask, and terminal cards never
 * regress to running on a late producer heartbeat.
 */
export function foldCopilotRunFrames(
  previous: CopilotRunView,
  incoming: CopilotRunJobFrame[],
): CopilotRunView {
  const byId = new Map<number, CopilotRunJobFrame>();
  for (const item of [...previous.frames, ...incoming]) {
    if (!Number.isSafeInteger(item.event_id) || item.event_id <= 0 || byId.has(item.event_id)) {
      continue;
    }
    byId.set(item.event_id, item);
  }
  const frames = [...byId.values()].sort((a, b) => a.event_id - b.event_id);
  let phase: CopilotRunPhase = 'queued';
  let replyText = '';
  let checkpointEventId: string | undefined;
  const subtasks = new Map<string, MutableSubtask>();

  for (const item of frames) {
    const terminalRun = TERMINAL_RUN_PHASES.has(phase);
    switch (item.event_type) {
      case 'copilot_run.queued':
        break;
      case 'copilot_run.started':
        if (!terminalRun) phase = 'running';
        break;
      case COPILOT_RUN_STEP_EVENT: {
        if (terminalRun) break;
        phase = 'running';
        const event = parseSubtaskPayload(item.payload);
        if (!event) break;
        const current = subtasks.get(event.subtask_id);
        if (current && TERMINAL_SUBTASKS.has(current.status)) break;
        subtasks.set(event.subtask_id, {
          id: event.subtask_id,
          // SDK task_notification has no description, so the backend uses a
          // generic terminal fallback. Keep the prior descriptive label when
          // one exists; the card must not jump from “核对 42 次作答” to merely
          // “子任务已完成”. A terminal-only replay still uses the fallback.
          label: current && TERMINAL_FALLBACK_LABELS.has(event.label) ? current.label : event.label,
          status: event.status,
          ...(event.summary ? { summary: event.summary } : {}),
          ...(event.error ? { error: event.error } : {}),
          lastEventId: item.event_id,
          firstEventId: current?.firstEventId ?? item.event_id,
        });
        break;
      }
      case 'copilot_run.delta': {
        if (terminalRun) break;
        phase = 'running';
        const text = typeof item.payload.text === 'string' ? item.payload.text : '';
        if (text) replyText += text;
        break;
      }
      case 'copilot_run.reply': {
        if (terminalRun) break;
        phase = 'running';
        if (typeof item.payload.reply_md === 'string') replyText = item.payload.reply_md;
        if (typeof item.payload.checkpoint_event_id === 'string') {
          checkpointEventId = item.payload.checkpoint_event_id;
        }
        break;
      }
      case 'copilot_run.done':
        if (!terminalRun) {
          phase = 'completed';
          if (typeof item.payload.checkpoint_event_id === 'string') {
            checkpointEventId = item.payload.checkpoint_event_id;
          }
        }
        break;
      case 'copilot_run.failed':
        if (!terminalRun) {
          phase = 'failed';
          if (typeof item.payload.checkpoint_event_id === 'string') {
            checkpointEventId = item.payload.checkpoint_event_id;
          }
        }
        break;
      default:
        // Cursor still advances over unknown events; their payload never enters UI state.
        break;
    }
  }

  return {
    phase,
    lastEventId: frames.at(-1)?.event_id ?? 0,
    replyText,
    ...(checkpointEventId ? { checkpointEventId } : {}),
    subtasks: [...subtasks.values()]
      .sort((a, b) => a.firstEventId - b.firstEventId)
      .map(({ firstEventId: _firstEventId, ...subtask }) => subtask),
    frames,
  };
}

/** SSE parser shared by the inline chat response and durable job-event stream. */
export async function* parseCopilotSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedSseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const parseFrame = (frame: string): ParsedSseEvent | null => {
    let event = 'message';
    let id: number | undefined;
    const dataLines: string[] = [];
    for (const rawLine of frame.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('id:')) {
        const parsed = Number.parseInt(line.slice(3).trim(), 10);
        if (Number.isSafeInteger(parsed) && parsed > 0) id = parsed;
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (dataLines.length === 0) return null;
    return { ...(id ? { id } : {}), event, data: dataLines.join('\n') };
  };

  const drainComplete = function* (): Generator<ParsedSseEvent> {
    let separator = buffer.indexOf('\n\n');
    while (separator !== -1) {
      const parsed = parseFrame(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      if (parsed) yield parsed;
      separator = buffer.indexOf('\n\n');
    }
  };

  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      yield* drainComplete();
    }
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, '\n');
    yield* drainComplete();
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export interface ConsumeDurableCopilotRunOptions {
  location: string;
  fetchResponse: (input: string, init?: RequestInit) => Promise<Response>;
  onUpdate?: (state: CopilotRunView) => void;
  /** Number of reconnects after the initial request. */
  maxReconnects?: number;
  signal?: AbortSignal;
}

/**
 * Consume the generic job-event endpoint with an explicit Last-Event-ID cursor.
 * Native EventSource is intentionally not used because `/api/*` requires the
 * authenticated `apiFetch` header. A non-terminal close reconnects; terminal
 * done/failed aborts the open SSE response and returns one folded view.
 */
export async function consumeDurableCopilotRun(
  options: ConsumeDurableCopilotRunOptions,
): Promise<CopilotRunView> {
  const maxReconnects = Math.max(0, options.maxReconnects ?? 3);
  let state = createCopilotRunView();
  let reconnects = 0;

  while (true) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    options.signal?.addEventListener('abort', relayAbort, { once: true });
    const headers =
      state.lastEventId > 0 ? { 'Last-Event-ID': String(state.lastEventId) } : undefined;

    try {
      const response = await options.fetchResponse(options.location, {
        ...(headers ? { headers } : {}),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`durable stream failed (${response.status})`);
      if (!response.body) throw new Error('durable stream has no body');

      for await (const event of parseCopilotSseStream(response.body)) {
        if (event.event === 'error') throw new Error('durable stream failed');
        const frame = parseCopilotRunJobFrame(event.data);
        if (!frame) continue;
        state = foldCopilotRunFrames(state, [frame]);
        options.onUpdate?.(state);
        if (TERMINAL_RUN_PHASES.has(state.phase)) {
          controller.abort();
          return state;
        }
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (TERMINAL_RUN_PHASES.has(state.phase)) return state;
      if (reconnects >= maxReconnects) throw error;
      reconnects += 1;
      continue;
    } finally {
      options.signal?.removeEventListener('abort', relayAbort);
      controller.abort();
    }

    if (reconnects >= maxReconnects) {
      throw new Error('durable stream closed before a terminal event');
    }
    reconnects += 1;
  }
}
