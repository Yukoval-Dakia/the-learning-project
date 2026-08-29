/**
 * YUK-936 (ADR-0054) — per-conversation inline Copilot query mutex.
 *
 * YUK-842 admission slots are provider-wide, not per learning_session. This mutex
 * serializes foreground inline Copilot POSTs on the same product conversation so a
 * resumed query never starts while the previous turn's provider session is still
 * acquired on this app process.
 */
const queryChains = new Map<string, Promise<void>>();

export async function withCopilotConversationQueryMutex<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = queryChains.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = prior.then(() => gate);
  queryChains.set(sessionId, tail);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (queryChains.get(sessionId) === tail) {
      queryChains.delete(sessionId);
    }
  }
}

/** Test-only reset — clears in-process waiters between unit cases. */
export function resetCopilotConversationQueryMutexForTests(): void {
  queryChains.clear();
}
