/** Process-local registry for Agent SDK sessions owned by this worker/runtime. */
const ownedSessions = new Map<string, string>();

export function registerCopilotWorkerSession(conversationId: string, sessionId: string): void {
  if (conversationId && sessionId) ownedSessions.set(conversationId, sessionId);
}

export function isCopilotWorkerSessionOwned(conversationId: string, sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && ownedSessions.get(conversationId) === sessionId);
}

export function clearCopilotWorkerSession(conversationId: string, sessionId?: string): void {
  if (!sessionId || ownedSessions.get(conversationId) === sessionId) ownedSessions.delete(conversationId);
}
