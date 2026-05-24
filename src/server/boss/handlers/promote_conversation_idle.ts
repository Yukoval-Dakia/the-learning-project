// YUK-14 — promote stale active conversation sessions to status='idle'.
//
// design/2026-05-24-teaching-idle-state-machine.md §"Idle clock" rules: a
// conversation is "idle" when the last user message (NOT agent reply) was
// more than IDLE_MS ago. Agent replies do not reset the idle clock by design,
// so a long chain of agent autopilot turns won't keep a session active forever
// (forward-compat for future dreaming triggers — out of scope this PR).
//
// Runs every minute. Per-row transition uses single-owner
// Conversation.idleConversation; the inner transaction handles T4 conflicts
// (e.g. a /turn race resuming the session between SELECT and UPDATE) by
// rejecting — we swallow the 409 here as a lost-race no-op skip, identical
// to prune_orphan_review_sessions handling.

import { sql } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { Conversation } from '@/server/session';

export const IDLE_MS = 5 * 60 * 1000;

/**
 * Returns ids of `active` conversation sessions whose latest user-message
 * event (event.actor_kind='user') is older than the cutoff. If a session has
 * NO user message yet, fall back to `started_at` — the conversation began but
 * the user never typed, so once started_at < cutoff it's idle.
 */
async function selectIdleCandidates(db: Db, cutoff: Date): Promise<string[]> {
  const cutoffIso = cutoff.toISOString();
  const rows = await db.execute(
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
  return (rows as unknown as Array<{ id: string }>).map((r) => r.id);
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
      // Lost race: /turn route resumed the session (T2b) or another caller
      // transitioned it between our SELECT and UPDATE. Terminal states or
      // already-idle = fine.
      skipped += 1;
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
