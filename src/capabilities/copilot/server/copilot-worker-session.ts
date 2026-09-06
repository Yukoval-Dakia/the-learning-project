import {
  clearCopilotSessionContextDelivery,
  markCopilotSessionContextDelivered,
} from './live-session-context';

/** An optimization only: evicted/foreign conversations rebuild from durable history. */
const ownedSessions = new Map<string, string>();
const MAX_OWNED_CONVERSATIONS = 256;

export function registerCopilotWorkerSession(
  conversationId: string,
  sessionId: string,
  contextDigest: string,
): void {
  clearCopilotWorkerSession(conversationId);
  ownedSessions.set(conversationId, sessionId);
  markCopilotSessionContextDelivered(sessionId, contextDigest);
  while (ownedSessions.size > MAX_OWNED_CONVERSATIONS) {
    const oldest = ownedSessions.keys().next().value;
    if (oldest === undefined) break;
    clearCopilotWorkerSession(oldest);
  }
}

export function isCopilotWorkerSessionOwned(
  conversationId: string,
  sessionId: string | null | undefined,
): boolean {
  return Boolean(sessionId && ownedSessions.get(conversationId) === sessionId);
}

export function clearCopilotWorkerSession(conversationId: string, sessionId?: string): void {
  const owned = ownedSessions.get(conversationId);
  if (owned && (!sessionId || owned === sessionId)) {
    ownedSessions.delete(conversationId);
    clearCopilotSessionContextDelivery(owned);
  }
}
