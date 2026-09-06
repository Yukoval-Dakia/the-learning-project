/** Process-local registry for Agent SDK sessions owned by this worker/runtime. */
const ownedSessions = new Map<string, { sessionId: string; contextDigest: string }>();

export function registerCopilotWorkerSession(conversationId: string, sessionId: string, contextDigest = ''): void {
  if (conversationId && sessionId) ownedSessions.set(conversationId, { sessionId, contextDigest });
}

export function isCopilotWorkerSessionOwned(conversationId: string, sessionId: string | null | undefined, contextDigest?: string): boolean {
  const owned = ownedSessions.get(conversationId);
  return Boolean(sessionId && owned?.sessionId === sessionId && (contextDigest === undefined || owned.contextDigest === contextDigest));
}

export function clearCopilotWorkerSession(conversationId: string, sessionId?: string): void {
  if (!sessionId || ownedSessions.get(conversationId)?.sessionId === sessionId) ownedSessions.delete(conversationId);
}
