// YUK-757 — page-reload handoff for one already-accepted durable Copilot run.
//
// The server-side run remains authoritative in job_events. sessionStorage only
// preserves the stable Location and the two local row ids long enough for this
// tab to reconnect from cursor zero after a Dock remount/reload. No progress,
// model transcript, reasoning, credentials or provider data is stored here.

export const DURABLE_COPILOT_RECONNECT_STORAGE_KEY = 'loom:copilot:durable-reconnect:v1';

const STORAGE_VERSION = 1;
const MAX_RUN_ID_CHARS = 256;
const MAX_MESSAGE_ID_CHARS = 160;
const MAX_USER_MESSAGE_CHARS = 4_000;

export interface PersistedDurableCopilotReconnect {
  v: typeof STORAGE_VERSION;
  runId: string;
  location: string;
  userMessageId: string;
  aiMessageId: string;
  userMessage: string;
}

function browserSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars ? value : null;
}

/** Accept only the same-origin generic Copilot job-events path emitted by chat.ts. */
export function durableRunIdFromLocation(location: unknown): string | null {
  if (typeof location !== 'string') return null;
  const match = /^\/api\/jobs\/copilot_run\/([^/?#]+)\/events$/.exec(location);
  if (!match?.[1]) return null;
  try {
    const runId = decodeURIComponent(match[1]);
    if (!boundedString(runId, MAX_RUN_ID_CHARS)) return null;
    return location === `/api/jobs/copilot_run/${encodeURIComponent(runId)}/events` ? runId : null;
  } catch {
    return null;
  }
}

function parsePersistedDurableCopilotReconnect(
  value: unknown,
): PersistedDurableCopilotReconnect | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.v !== STORAGE_VERSION) return null;
  const location = boundedString(candidate.location, 512);
  const runId = boundedString(candidate.runId, MAX_RUN_ID_CHARS);
  const userMessageId = boundedString(candidate.userMessageId, MAX_MESSAGE_ID_CHARS);
  const aiMessageId = boundedString(candidate.aiMessageId, MAX_MESSAGE_ID_CHARS);
  const userMessage = boundedString(candidate.userMessage, MAX_USER_MESSAGE_CHARS);
  if (!location || !runId || !userMessageId || !aiMessageId || !userMessage) return null;
  if (durableRunIdFromLocation(location) !== runId) return null;
  return { v: STORAGE_VERSION, runId, location, userMessageId, aiMessageId, userMessage };
}

export function loadPersistedDurableCopilotReconnect(
  storage: Storage | null = browserSessionStorage(),
): PersistedDurableCopilotReconnect | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = parsePersistedDurableCopilotReconnect(JSON.parse(raw));
    if (!parsed) storage.removeItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY);
    return parsed;
  } catch {
    return null;
  }
}

export function persistDurableCopilotReconnect(
  handle: PersistedDurableCopilotReconnect,
  storage: Storage | null = browserSessionStorage(),
): boolean {
  const parsed = parsePersistedDurableCopilotReconnect(handle);
  if (!storage || !parsed) return false;
  try {
    storage.setItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

/** Clear only the run that just settled; never erase a newer accepted handle. */
export function clearPersistedDurableCopilotReconnect(
  runId: string,
  storage: Storage | null = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    const current = loadPersistedDurableCopilotReconnect(storage);
    if (current?.runId === runId) storage.removeItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY);
  } catch {
    // Storage is best-effort. The accepted server run remains authoritative.
  }
}
