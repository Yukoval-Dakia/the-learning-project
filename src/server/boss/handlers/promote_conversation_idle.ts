// Idle follows the last user message, not an agent reply. Autopilot must not keep the session active.
// Any error from the transition is skipped, and the job still completes.

import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { Conversation } from '@/server/session';

export const IDLE_MS = 5 * 60 * 1000;

/** A session with no user message yet uses started_at. The user never typed. */
async function selectIdleCandidates(db: Db, cutoff: Date): Promise<string[]> {
  const cutoffIso = cutoff.toISOString();
  const rows = await db.execute<{ id: string }>(
    sql`
      SELECT ls.id AS id
      FROM learning_session ls
      LEFT JOIN LATERAL (
        SELECT MAX(e.created_at) AS at
        FROM event e
        WHERE e.session_id = ls.id
          AND e.actor_kind = 'user'
      ) last_user ON true
      WHERE ls.type = 'conversation'
        AND ls.status = 'active'
        AND COALESCE(last_user.at, ls.started_at) < ${cutoffIso}::timestamptz
    `,
  );
  return rows.map((r) => r.id);
}

export async function runPromoteConversationIdle(
  db: Db,
): Promise<{ promoted: number; skipped: number }> {
  const cutoff = new Date(Date.now() - IDLE_MS);
  const ids = await selectIdleCandidates(db, cutoff);

  let promoted = 0;
  let skipped = 0;
  for (const id of ids) {
    try {
      await Conversation.idleConversation(db, id);
      promoted += 1;
    } catch (err) {
      skipped += 1;
      // Expected race: between the SELECT and the UPDATE the user may close or
      // abandon the session (T5/T6/T7), or an overlapping promote may have
      // already idled it. Terminal or already-idle is fine; keep going.
      console.warn(`[promote_conversation_idle] skip ${id}:`, (err as Error).message);
    }
  }
  return { promoted, skipped };
}

export function buildPromoteConversationIdleHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runPromoteConversationIdle(db);
    if (result.promoted > 0 || result.skipped > 0) {
      console.log('[promote_conversation_idle] result', result);
    }
  };
}
