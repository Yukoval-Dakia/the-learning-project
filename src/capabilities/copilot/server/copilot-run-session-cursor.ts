// The durable run's native provider-session cursor.
//
// Session reuse is only safe when two stores agree: the conversation row's
// persisted cursor (`agent_sdk_session_id`, a `pi:<uuid>` marker) and this
// worker process's registered ownership. This module owns the full decision
// and mutation surface for that pairing — reading, resume selection, commit,
// and guarded discard — so no consumer drives the two stores separately.
// Ordering is consolidated, not hardened: the in-process registry is not
// transactional with Postgres, so a rolled-back write does not roll back
// memory; this preserves the pre-existing protocol unchanged.

import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  clearAgentSdkSessionId,
  getAgentSdkSessionId,
  setAgentSdkSessionId,
} from '@/server/session/conversation';
import {
  clearCopilotWorkerSession,
  isCopilotWorkerSessionOwned,
  registerCopilotWorkerSession,
} from './copilot-worker-session';

/** Discard armed against the cursor captured earlier in the run. */
export type WorkerSessionCursorDiscard = (database?: Db | Tx) => Promise<void>;

/**
 * Capture the conversation's persisted cursor and return a discard bound to
 * that captured value. The read happens at capture time; the returned closure
 * clears the in-process half only when a cursor was captured, then clears the
 * durable row under the caller's transaction with the captured value as the
 * expected-cursor guard, so a cursor superseded since capture is never
 * cleared.
 */
export async function captureWorkerSessionCursor(
  database: Db | Tx,
  conversationId: string,
): Promise<WorkerSessionCursorDiscard> {
  const capturedCursor = await getAgentSdkSessionId(database, conversationId);
  return async (target: Db | Tx = database) => {
    if (capturedCursor) clearCopilotWorkerSession(conversationId, capturedCursor);
    await clearAgentSdkSessionId(target, conversationId, capturedCursor);
  };
}

/**
 * Select the native session this worker may resume. The persisted cursor is
 * always read — including for answer-only runs — so the durable observation
 * ordering is unchanged; the answer-only gate and this process's registered
 * ownership then decide. Persisted ids from another process/app intentionally
 * cold-start: `pi:<uuid>` markers mean durable turns replay into
 * context.messages instead (pi-agent-adapter piSessionReplay).
 */
export async function selectResumableWorkerSession(
  database: Db | Tx,
  conversationId: string,
  answerOnly: boolean,
): Promise<string | undefined> {
  const persistedCursor = await getAgentSdkSessionId(database, conversationId);
  return !answerOnly &&
    isCopilotWorkerSessionOwned(conversationId, persistedCursor) &&
    persistedCursor
    ? persistedCursor
    : undefined;
}

/**
 * Clear the worker-session cursor persisted for a run's conversation. Used by
 * the settlement owner when a failure outcome commits: the failed attempt's
 * native session must not be resumed by a later turn.
 */
export async function discardRunWorkerSessionCursor(tx: Tx, runId: string): Promise<void> {
  const [ask] = await tx
    .select({ sessionId: event.session_id })
    .from(event)
    .where(eq(event.id, runId))
    .limit(1);
  if (!ask?.sessionId) return;
  const discard = await captureWorkerSessionCursor(tx, ask.sessionId);
  await discard(tx);
}

/**
 * Commit the freshly resumed native session: persist the cursor, then mark
 * this worker as its owner. Callers must already hold the run's settlement
 * lock so no successor pickup can observe a half-adopted session.
 */
export async function commitWorkerSessionCursor(
  tx: Tx,
  conversationId: string,
  sessionId: string,
  contextDigest: string,
): Promise<void> {
  await setAgentSdkSessionId(tx, conversationId, sessionId);
  registerCopilotWorkerSession(conversationId, sessionId, contextDigest);
}
