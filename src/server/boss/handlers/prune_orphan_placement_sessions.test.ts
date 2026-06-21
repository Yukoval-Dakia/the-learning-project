import { learning_session } from '@/db/schema';
import { Placement, Review } from '@/server/session';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runPruneOrphanPlacementSessions } from './prune_orphan_placement_sessions';

async function ageSession(sessionId: string, ageMs: number) {
  const db = testDb();
  await db
    .update(learning_session)
    .set({ started_at: new Date(Date.now() - ageMs) })
    .where(eq(learning_session.id, sessionId));
}

describe('runPruneOrphanPlacementSessions', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('abandons placement sessions in started state older than 6h', async () => {
    const db = testDb();
    const { sessionId: old1 } = await Placement.startPlacementSession(db, { goalId: null });
    const { sessionId: old2 } = await Placement.startPlacementSession(db, { goalId: null });
    const { sessionId: fresh } = await Placement.startPlacementSession(db, { goalId: null });
    await ageSession(old1, 7 * 60 * 60 * 1000);
    await ageSession(old2, 12 * 60 * 60 * 1000);

    const result = await runPruneOrphanPlacementSessions(db);
    expect(result.abandoned).toBe(2);

    const byId = new Map((await db.select().from(learning_session)).map((r) => [r.id, r.status]));
    expect(byId.get(old1)).toBe('abandoned');
    expect(byId.get(old2)).toBe('abandoned');
    expect(byId.get(fresh)).toBe('started'); // fresh probe untouched
  });

  it('does not touch placement sessions already in completed/abandoned state', async () => {
    const db = testDb();
    const { sessionId } = await Placement.startPlacementSession(db, { goalId: null });
    await Placement.completePlacementSession(db, sessionId);
    await ageSession(sessionId, 24 * 60 * 60 * 1000);

    const result = await runPruneOrphanPlacementSessions(db);
    expect(result.abandoned).toBe(0);

    const rows = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('completed');
  });

  it('does not touch review sessions (scopes to type=placement only)', async () => {
    const db = testDb();
    // a stale STARTED placement + a same-age stale started review: only the placement
    // is swept; the review is left to its own sibling sweep (type-scoping via WHERE).
    const { sessionId: placement } = await Placement.startPlacementSession(db, { goalId: null });
    const { sessionId: review } = await Review.startReviewSession(db);
    await ageSession(placement, 9 * 60 * 60 * 1000);
    await ageSession(review, 9 * 60 * 60 * 1000);

    const result = await runPruneOrphanPlacementSessions(db);
    expect(result.abandoned).toBe(1); // only the placement probe

    const byId = new Map((await db.select().from(learning_session)).map((r) => [r.id, r.status]));
    expect(byId.get(placement)).toBe('abandoned');
    expect(byId.get(review)).toBe('started'); // review untouched by the placement sweep
  });

  it('returns abandoned=0 when no orphans', async () => {
    const db = testDb();
    const result = await runPruneOrphanPlacementSessions(db);
    expect(result.abandoned).toBe(0);
  });
});
