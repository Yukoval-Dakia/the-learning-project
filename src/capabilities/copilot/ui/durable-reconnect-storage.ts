// YUK-948 — reload handoff for POSTs whose 202 acceptance is not yet known.
//
// Accepted runs are deliberately NOT cached here. GET /api/copilot/turns is the
// authority for every accepted/queued/running run, including runs accepted by a
// different tab. The only browser-owned recovery state is the exact
// Idempotency-Key + normalized body for a POST that may have committed before
// its response was lost. Retrying that tuple can only recover the same run.

import type { CopilotChatRequestT } from '@/capabilities/copilot/server/chat-contracts';

export const PENDING_COPILOT_TURN_STORAGE_KEY = 'loom:copilot:pending-turns:v2';
const LEGACY_PENDING_COPILOT_TURN_STORAGE_KEY = 'loom:copilot:pending-turn:v1';
const LEGACY_DURABLE_COPILOT_RECONNECT_STORAGE_KEY = 'loom:copilot:durable-reconnect:v1';

const STORAGE_VERSION = 2;
const MAX_PENDING_TURNS = 32;
const MAX_RUN_ID_CHARS = 256;
const MAX_MESSAGE_ID_CHARS = 160;
const MAX_USER_MESSAGE_CHARS = 4_000;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;

export type PersistedPendingCopilotRequestBody = Pick<
  CopilotChatRequestT,
  | 'user_message'
  | 'triggered_by'
  | 'skill_context'
  | 'ambient_context'
  | 'correction_target_turn_id'
> & { session_id: string };

export interface PersistedPendingCopilotTurn {
  v: typeof STORAGE_VERSION;
  idempotencyKey: string;
  userMessageId: string;
  aiMessageId: string;
  userMessage: string;
  requestBody: PersistedPendingCopilotRequestBody;
}

interface PersistedPendingCopilotTurns {
  v: typeof STORAGE_VERSION;
  turns: PersistedPendingCopilotTurn[];
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
    // Storage is best-effort; server idempotency remains authoritative.
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

function parsePendingCopilotTurn(value: unknown): PersistedPendingCopilotTurn | null {
  const candidate = objectRecord(value);
  if (!candidate || (candidate.v !== STORAGE_VERSION && candidate.v !== 1)) return null;
  const idempotencyKey = boundedString(candidate.idempotencyKey, MAX_IDEMPOTENCY_KEY_CHARS);
  const userMessageId = boundedString(candidate.userMessageId, MAX_MESSAGE_ID_CHARS);
  const aiMessageId =
    boundedString(candidate.aiMessageId, MAX_MESSAGE_ID_CHARS) ??
    (userMessageId ? boundedString(`${userMessageId}_reply`, MAX_MESSAGE_ID_CHARS) : null);
  const userMessage = boundedString(candidate.userMessage, MAX_USER_MESSAGE_CHARS);
  const rawBody = objectRecord(candidate.requestBody);
  if (
    !idempotencyKey ||
    !userMessageId ||
    !aiMessageId ||
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

  const correctionTargetTurnId =
    rawBody.correction_target_turn_id === undefined
      ? undefined
      : boundedString(rawBody.correction_target_turn_id, 160);
  if (rawBody.correction_target_turn_id !== undefined && !correctionTargetTurnId) return null;

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
    aiMessageId,
    userMessage,
    requestBody: {
      session_id: sessionId,
      user_message: userMessage,
      triggered_by: 'chat',
      ...(skillContext ? { skill_context: skillContext } : {}),
      ...(ambientContext ? { ambient_context: ambientContext } : {}),
      ...(correctionTargetTurnId ? { correction_target_turn_id: correctionTargetTurnId } : {}),
    },
  };
}

function parsePendingCollection(value: unknown): PersistedPendingCopilotTurn[] | null {
  const candidate = objectRecord(value);
  if (!candidate || candidate.v !== STORAGE_VERSION || !Array.isArray(candidate.turns)) return null;
  if (candidate.turns.length > MAX_PENDING_TURNS) return null;
  const turns: PersistedPendingCopilotTurn[] = [];
  const keys = new Set<string>();
  for (const value of candidate.turns) {
    const turn = parsePendingCopilotTurn(value);
    if (!turn || keys.has(turn.idempotencyKey)) return null;
    keys.add(turn.idempotencyKey);
    turns.push(turn);
  }
  return turns;
}

function writePendingCollection(storage: Storage, turns: PersistedPendingCopilotTurn[]): boolean {
  try {
    if (turns.length === 0) {
      storage.removeItem(PENDING_COPILOT_TURN_STORAGE_KEY);
      return true;
    }
    const record: PersistedPendingCopilotTurns = { v: STORAGE_VERSION, turns };
    storage.setItem(PENDING_COPILOT_TURN_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** Load every unresolved POST. A bounded v1 singleton is migrated once. */
export function loadPersistedPendingCopilotTurns(
  storage: Storage | null = browserSessionStorage(),
): PersistedPendingCopilotTurn[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_COPILOT_TURN_STORAGE_KEY);
    if (raw) {
      const parsed = parsePendingCollection(JSON.parse(raw));
      if (parsed) {
        removeStorageItem(storage, LEGACY_PENDING_COPILOT_TURN_STORAGE_KEY);
        return parsed;
      }
      removeStorageItem(storage, PENDING_COPILOT_TURN_STORAGE_KEY);
    }

    const legacyRaw = storage.getItem(LEGACY_PENDING_COPILOT_TURN_STORAGE_KEY);
    if (!legacyRaw) return [];
    const legacy = parsePendingCopilotTurn(JSON.parse(legacyRaw));
    removeStorageItem(storage, LEGACY_PENDING_COPILOT_TURN_STORAGE_KEY);
    if (!legacy) return [];
    writePendingCollection(storage, [legacy]);
    return [legacy];
  } catch {
    removeStorageItem(storage, PENDING_COPILOT_TURN_STORAGE_KEY);
    removeStorageItem(storage, LEGACY_PENDING_COPILOT_TURN_STORAGE_KEY);
    return [];
  }
}

/** Upsert one logical POST without overwriting another unresolved turn. */
export function persistPendingCopilotTurn(
  turn: PersistedPendingCopilotTurn,
  storage: Storage | null = browserSessionStorage(),
): boolean {
  const parsed = parsePendingCopilotTurn(turn);
  if (!storage || !parsed) return false;
  const current = loadPersistedPendingCopilotTurns(storage);
  const next = current.some((item) => item.idempotencyKey === parsed.idempotencyKey)
    ? current.map((item) => (item.idempotencyKey === parsed.idempotencyKey ? parsed : item))
    : [...current, parsed];
  if (next.length > MAX_PENDING_TURNS) return false;
  return writePendingCollection(storage, next);
}

/** Clear only the logical turn whose response is now definitive. */
export function clearPersistedPendingCopilotTurn(
  idempotencyKey: string,
  storage: Storage | null = browserSessionStorage(),
): void {
  if (!storage) return;
  const current = loadPersistedPendingCopilotTurns(storage);
  if (!current.some((turn) => turn.idempotencyKey === idempotencyKey)) return;
  writePendingCollection(
    storage,
    current.filter((turn) => turn.idempotencyKey !== idempotencyKey),
  );
}

/** Old accepted-handle caches must never compete with the server snapshot. */
export function discardLegacyDurableCopilotReconnect(
  storage: Storage | null = browserSessionStorage(),
): void {
  if (storage) removeStorageItem(storage, LEGACY_DURABLE_COPILOT_RECONNECT_STORAGE_KEY);
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
