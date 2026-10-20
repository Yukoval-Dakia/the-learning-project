// The durable run's native provider-session cursor.
//
// Session reuse is only safe when two stores agree: the conversation row's
// persisted cursor (`agent_sdk_session_id`, a `pi:<uuid>` marker) and this
// worker process's registered ownership. Both halves move together through
// this module — a run may resume only a session it observed and registered
// in-process, and a discarded or superseded cursor clears both halves under
// the caller's transaction. Consumers never drive the two stores separately.

import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import {
  clearAgentSdkSessionId,
  getAgentSdkSessionId,
  setAgentSdkSessionId,
} from '@/server/session/conversation';
import { clearCopilotWorkerSession, registerCopilotWorkerSession } from './copilot-worker-session';

/** Read the persisted native-session cursor without judging ownership. */
export async function readWorkerSessionCursor(
  database: Db | Tx,
  conversationId: string,
): Promise<string | null> {
  return getAgentSdkSessionId(database, conversationId);
}

/**
 * Discard the persisted cursor and this process's registered session. When
 * `expectedCursor` is given it guards both halves so a superseded cursor is
 * never cleared; the durable clear still runs unconditionally so a missing
 * expected value cannot leave a stale pointer behind.
 */
export async function discardWorkerSessionCursor(
  database: Db | Tx,
  conversationId: string,
  expectedCursor?: string | null,
): Promise<void> {
  if (expectedCursor) clearCopilotWorkerSession(conversationId, expectedCursor);
  await clearAgentSdkSessionId(database, conversationId, expectedCursor);
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
  const cursor = await getAgentSdkSessionId(tx, ask.sessionId);
  if (cursor) clearCopilotWorkerSession(ask.sessionId, cursor);
  await clearAgentSdkSessionId(tx, ask.sessionId, cursor);
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
