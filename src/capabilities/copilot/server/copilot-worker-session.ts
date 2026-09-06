/** Process-local registry for Agent SDK sessions owned by this worker/runtime. */
const ownedSessions = new Set<string>();

export function registerCopilotWorkerSession(sessionId: string): void {
  if (sessionId) ownedSessions.add(sessionId);
}

export function isCopilotWorkerSessionOwned(sessionId: string | null | undefined): boolean {
  return Boolean(sessionId && ownedSessions.has(sessionId));
}

export function clearCopilotWorkerSession(sessionId: string): void {
  ownedSessions.delete(sessionId);
}
