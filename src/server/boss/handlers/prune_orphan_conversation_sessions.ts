// YUK-14 — abandon conversation sessions stuck in active/idle for >6h.
//
// design/2026-05-24-teaching-idle-state-machine.md §"Orphan cron":
// 6h cutoff (same window as ADR-0013 review prune; schedule offset by 10min
// to avoid lock contention with prune_orphan_review_sessions). Catches:
//   - tab killed mid-session, pagehide sendBeacon dropped
//   - mobile background eviction without page lifecycle event
//   - dev hot-reload abandoning a conversation
// abandons via Conversation.abandonConversation(reason='orphan_cron').

import { and, eq, lt, or } from 'drizzle-orm';
import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { learning_session } from '@/db/schema';
import { Conversation } from '@/server/session';

const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000;

export async function runPruneOrphanConversationSessions(
  db: Db,
): Promise<{ abandoned: number; skipped: number }> {
  const cutoff = new Date(Date.now() - ORPHAN_AGE_MS);
  const rows = await db
    .select({ id: learning_session.id })
    .from(learning_session)
    .where(
      and(
        eq(learning_session.type, 'conversation'),
        or(
          eq(learning_session.status, 'active'),
          eq(learning_session.status, 'idle'),
        ),
        lt(learning_session.started_at, cutoff),
      ),
    );

  let abandoned = 0;
  let skipped = 0;
  for (const r of rows) {
    try {
      await Conversation.abandonConversation(db, r.id, 'orphan_cron');
      abandoned += 1;
    } catch (err) {
      // Lost-race: another caller (sendBeacon end / promote_idle handler
      // running concurrently) transitioned it between SELECT and abandon.
      // Terminal states are fine — skip.
      skipped += 1;
      console.warn(`[prune_orphan_conversation_sessions] skip ${r.id}:`, (err as Error).message);
    }
  }
  return { abandoned, skipped };
}

export function buildPruneOrphanConversationSessionsHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    const result = await runPruneOrphanConversationSessions(db);
    console.log('[prune_orphan_conversation_sessions] result', result);
  };
}
