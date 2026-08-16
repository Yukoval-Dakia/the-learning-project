// YUK-757 — page-reload handoff for one pending/accepted durable Copilot run.
//
// The server-side run remains authoritative in job_events. sessionStorage only
// preserves either the pre-acceptance key + exact request body or the accepted
// stable Location long enough for this tab to recover after a Dock remount.
// No progress, model transcript, reasoning, credentials or provider data is stored.

import type { CopilotChatRequestT } from '@/capabilities/copilot/server/chat-contracts';

export const DURABLE_COPILOT_RECONNECT_STORAGE_KEY = 'loom:copilot:durable-reconnect:v1';
export const PENDING_COPILOT_TURN_STORAGE_KEY = 'loom:copilot:pending-turn:v1';

const STORAGE_VERSION = 1;
const MAX_RUN_ID_CHARS = 256;
const MAX_MESSAGE_ID_CHARS = 160;
const MAX_USER_MESSAGE_CHARS = 4_000;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;

export type PersistedPendingCopilotRequestBody = Pick<
  CopilotChatRequestT,
  'user_message' | 'triggered_by' | 'skill_context' | 'ambient_context'
> & { session_id: string };

export interface PersistedPendingCopilotTurn {
  v: typeof STORAGE_VERSION;
  idempotencyKey: string;
  userMessageId: string;
  userMessage: string;
  requestBody: PersistedPendingCopilotRequestBody;
}

export interface PersistedDurableCopilotReconnect {
  v: typeof STORAGE_VERSION;
  sessionId: string;
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

function removeStorageItem(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Storage is best-effort.
  }
}

function boundedString(value: unknown, maxChars: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxChars ? value : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedEntityRef(value: unknown): { kind: string; id: string } | null {
  const candidate = objectRecord(value);
  if (!candidate) return null;
  const kind = boundedString(candidate.kind, 40);
  const id = boundedString(candidate.id, 120);
  return kind && id ? { kind, id } : null;
}

function parsePersistedPendingCopilotTurn(value: unknown): PersistedPendingCopilotTurn | null {
  const candidate = objectRecord(value);
  if (!candidate || candidate.v !== STORAGE_VERSION) return null;
  const idempotencyKey = boundedString(candidate.idempotencyKey, MAX_IDEMPOTENCY_KEY_CHARS);
  const userMessageId = boundedString(candidate.userMessageId, MAX_MESSAGE_ID_CHARS);
  const userMessage = boundedString(candidate.userMessage, MAX_USER_MESSAGE_CHARS);
  const rawBody = objectRecord(candidate.requestBody);
  if (
    !idempotencyKey ||
    !userMessageId ||
    !userMessage ||
    !rawBody ||
    rawBody.triggered_by !== 'chat' ||
    rawBody.user_message !== userMessage
  ) {
    return null;
  }

  let skillContext: CopilotChatRequestT['skill_context'];
  if (rawBody.skill_context !== undefined) {
    const rawSkill = objectRecord(rawBody.skill_context);
    const ref = boundedEntityRef(rawSkill?.ref);
    if (
      !rawSkill ||
      (rawSkill.skill !== 'teaching' && rawSkill.skill !== 'solve' && rawSkill.skill !== 'quiz') ||
      !ref
    ) {
      return null;
    }
    skillContext = { skill: rawSkill.skill, ref };
  }

  const sessionId = boundedString(rawBody.session_id, 160);
  if (!sessionId) return null;

  let ambientContext: CopilotChatRequestT['ambient_context'];
  if (rawBody.ambient_context !== undefined) {
    const rawAmbient = objectRecord(rawBody.ambient_context);
    const route = boundedString(rawAmbient?.route, 200);
    if (!rawAmbient || !route) return null;
    let focusedEntity: { kind: string; id: string } | undefined;
    if (rawAmbient.focused_entity !== undefined) {
      focusedEntity = boundedEntityRef(rawAmbient.focused_entity) ?? undefined;
      if (!focusedEntity) return null;
    }
    ambientContext = { route, ...(focusedEntity ? { focused_entity: focusedEntity } : {}) };
  }

  return {
    v: STORAGE_VERSION,
    idempotencyKey,
    userMessageId,
    userMessage,
    requestBody: {
      session_id: sessionId,
      user_message: userMessage,
      triggered_by: 'chat',
      ...(skillContext ? { skill_context: skillContext } : {}),
      ...(ambientContext ? { ambient_context: ambientContext } : {}),
    },
  };
}

export function loadPersistedPendingCopilotTurn(
  storage: Storage | null = browserSessionStorage(),
): PersistedPendingCopilotTurn | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY);
    if (!raw) return null;
    const parsed = parsePersistedPendingCopilotTurn(JSON.parse(raw));
    if (!parsed) removeStorageItem(storage, PENDING_COPILOT_TURN_STORAGE_KEY);
    return parsed;
  } catch {
    removeStorageItem(storage, PENDING_COPILOT_TURN_STORAGE_KEY);
    return null;
  }
}

export function persistPendingCopilotTurn(
  turn: PersistedPendingCopilotTurn,
  storage: Storage | null = browserSessionStorage(),
): boolean {
  const parsed = parsePersistedPendingCopilotTurn(turn);
  if (!storage || !parsed) return false;
  try {
    storage.setItem(PENDING_COPILOT_TURN_STORAGE_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

/** Clear only the logical turn whose response is now definitive. */
export function clearPersistedPendingCopilotTurn(
  idempotencyKey: string,
  storage: Storage | null = browserSessionStorage(),
): void {
  if (!storage) return;
  try {
    const current = loadPersistedPendingCopilotTurn(storage);
    if (current?.idempotencyKey === idempotencyKey) {
      storage.removeItem(PENDING_COPILOT_TURN_STORAGE_KEY);
    }
  } catch {
    // Storage is best-effort; server idempotency remains authoritative.
  }
}

/** An accepted Location supersedes any pre-acceptance handoff record. */
export function discardPersistedPendingCopilotTurn(
  storage: Storage | null = browserSessionStorage(),
): void {
  try {
    storage?.removeItem(PENDING_COPILOT_TURN_STORAGE_KEY);
  } catch {
    // Storage is best-effort.
  }
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
  const sessionId = boundedString(candidate.sessionId, 160);
  const runId = boundedString(candidate.runId, MAX_RUN_ID_CHARS);
  const userMessageId = boundedString(candidate.userMessageId, MAX_MESSAGE_ID_CHARS);
  const aiMessageId = boundedString(candidate.aiMessageId, MAX_MESSAGE_ID_CHARS);
  const userMessage = boundedString(candidate.userMessage, MAX_USER_MESSAGE_CHARS);
  if (!location || !sessionId || !runId || !userMessageId || !aiMessageId || !userMessage) {
    return null;
  }
  if (durableRunIdFromLocation(location) !== runId) return null;
  return {
    v: STORAGE_VERSION,
    sessionId,
    runId,
    location,
    userMessageId,
    aiMessageId,
    userMessage,
  };
}

export function loadPersistedDurableCopilotReconnect(
  storage: Storage | null = browserSessionStorage(),
): PersistedDurableCopilotReconnect | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DURABLE_COPILOT_RECONNECT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = parsePersistedDurableCopilotReconnect(JSON.parse(raw));
    if (!parsed) removeStorageItem(storage, DURABLE_COPILOT_RECONNECT_STORAGE_KEY);
    return parsed;
  } catch {
    removeStorageItem(storage, DURABLE_COPILOT_RECONNECT_STORAGE_KEY);
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
