import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { learning_session } from '@/db/schema';
import { Conversation } from '@/server/session';

import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runPruneOrphanConversationSessions } from './prune_orphan_conversation_sessions';

async function ageSession(sessionId: string, ageMs: number) {
  const db = testDb();
  const newStartedAt = new Date(Date.now() - ageMs);
  await db
    .update(learning_session)
    .set({ started_at: newStartedAt })
    .where(eq(learning_session.id, sessionId));
}

describe('runPruneOrphanConversationSessions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('abandons conversation sessions in active state older than 6h', async () => {
    const db = testDb();
    const { sessionId: old1 } = await Conversation.startConversation(db, { learningItemId: 'li_a' });
    const { sessionId: old2 } = await Conversation.startConversation(db, { learningItemId: 'li_b' });
    const { sessionId: fresh } = await Conversation.startConversation(db, {
      learningItemId: 'li_c',
    });
    await ageSession(old1, 7 * 60 * 60 * 1000);
    await ageSession(old2, 12 * 60 * 60 * 1000);

    const result = await runPruneOrphanConversationSessions(db);
    expect(result.abandoned).toBe(2);

    const rows = await db.select().from(learning_session);
    const byId = new Map(rows.map((r) => [r.id, r.status]));
    expect(byId.get(old1)).toBe('abandoned');
    expect(byId.get(old2)).toBe('abandoned');
    expect(byId.get(fresh)).toBe('active');
  });

  it('abandons conversation sessions in idle state older than 6h', async () => {
    const db = testDb();
    const { sessionId } = await Conversation.startConversation(db, { learningItemId: 'li_idle' });
    await Conversation.idleConversation(db, sessionId);
    await ageSession(sessionId, 7 * 60 * 60 * 1000);

    const result = await runPruneOrphanConversationSessions(db);
    expect(result.abandoned).toBe(1);

    const rows = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
  });

  it('does not touch sessions already in ended/abandoned state', async () => {
    const db = testDb();
    const { sessionId: endedId } = await Conversation.startConversation(db, {
      learningItemId: 'li_e',
    });
    await Conversation.endConversation(db, endedId);
    await ageSession(endedId, 24 * 60 * 60 * 1000);

    const { sessionId: abandonedId } = await Conversation.startConversation(db, {
      learningItemId: 'li_a',
    });
    await Conversation.abandonConversation(db, abandonedId, 'pagehide_explicit');
    await ageSession(abandonedId, 24 * 60 * 60 * 1000);

    const result = await runPruneOrphanConversationSessions(db);
    expect(result.abandoned).toBe(0);

    const ended = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, endedId));
    expect(ended[0].status).toBe('ended');
  });

  it('does NOT abandon review sessions (type filter)', async () => {
    const db = testDb();
    const { Review } = await import('@/server/session');
    const { sessionId } = await Review.startReviewSession(db);
    await ageSession(sessionId, 7 * 60 * 60 * 1000);

    const result = await runPruneOrphanConversationSessions(db);
    expect(result.abandoned).toBe(0);

    const rows = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('started'); // review session untouched
  });

  it('returns abandoned=0 when no orphans', async () => {
    const db = testDb();
    const result = await runPruneOrphanConversationSessions(db);
    expect(result.abandoned).toBe(0);
    expect(result.skipped).toBe(0);
  });
});
