import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { db } from '@/db/client';
import { event, job_events, learning_session } from '@/db/schema';
import { ApiError } from '@/server/http/errors';

import {
  abandonReviewSession,
  completeReviewSession,
  pauseReviewSession,
  resumeReviewSession,
  startReviewSession,
} from './review';

async function cleanup(sessionId: string): Promise<void> {
  await db.delete(event).where(eq(event.session_id, sessionId));
  await db.delete(learning_session).where(eq(learning_session.id, sessionId));
  await db.delete(job_events).where(eq(job_events.business_id, sessionId));
}

describe('Review.startReviewSession', () => {
  it('inserts learning_session(type=review, status=started) and returns sessionId', async () => {
    const { sessionId } = await startReviewSession(db);
    expect(sessionId).toBeTruthy();
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('review');
    expect(rows[0].status).toBe('started');
    expect(rows[0].started_at).toBeTruthy();
    expect(rows[0].ended_at).toBeNull();
    await cleanup(sessionId);
  });

  it('optionally stores goal_id', async () => {
    const { sessionId } = await startReviewSession(db, { goalId: 'g_xyz' });
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].goal_id).toBe('g_xyz');
    await cleanup(sessionId);
  });

  it('writes a job_events row but NO domain event (per-question events come later)', async () => {
    const { sessionId } = await startReviewSession(db);
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'review.started')).toBeTruthy();
    const events = await db.select().from(event).where(eq(event.session_id, sessionId));
    expect(events).toHaveLength(0);
    await cleanup(sessionId);
  });
});

describe('Review.completeReviewSession', () => {
  it('started → completed + ended_at set + version bump', async () => {
    const { sessionId } = await startReviewSession(db);
    await completeReviewSession(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('completed');
    expect(rows[0].ended_at).toBeTruthy();
    expect(rows[0].version).toBe(1);
    await cleanup(sessionId);
  });

  it('404 when session missing', async () => {
    await expect(completeReviewSession(db, 'never-existed')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });

  it('refuses to complete a non-review (type filter)', async () => {
    // Create an ingestion-type session and attempt to complete it as a review
    const id = 'ingest_for_filter_test';
    const now = new Date();
    await db.insert(learning_session).values({
      id,
      type: 'ingestion',
      status: 'started',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: 'vision_single',
      warnings: [],
      error_message: null,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });
    await expect(completeReviewSession(db, id)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await db.delete(learning_session).where(eq(learning_session.id, id));
  });

  it('rejects re-complete (status=completed → 409)', async () => {
    const { sessionId } = await startReviewSession(db);
    await completeReviewSession(db, sessionId);
    await expect(completeReviewSession(db, sessionId)).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId);
  });
});

describe('Review.abandonReviewSession', () => {
  it('started → abandoned + ended_at + version bump', async () => {
    const { sessionId } = await startReviewSession(db);
    await abandonReviewSession(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
    expect(rows[0].ended_at).toBeTruthy();
    await cleanup(sessionId);
  });

  it('rejects abandon-after-complete (status=completed → 409)', async () => {
    const { sessionId } = await startReviewSession(db);
    await completeReviewSession(db, sessionId);
    await expect(abandonReviewSession(db, sessionId)).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId);
  });

  it('writes no domain event', async () => {
    const { sessionId } = await startReviewSession(db);
    await abandonReviewSession(db, sessionId);
    const events = await db.select().from(event).where(eq(event.session_id, sessionId));
    expect(events).toHaveLength(0);
    await cleanup(sessionId);
  });
});

// ---------- YUK-57: pauseReviewSession ----------

describe('Review.pauseReviewSession', () => {
  it('started → paused + version bump + ended_at stays null', async () => {
    const { sessionId } = await startReviewSession(db);
    await pauseReviewSession(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('paused');
    expect(rows[0].ended_at).toBeNull();
    expect(rows[0].version).toBe(1);
    await cleanup(sessionId);
  });

  it('writes a job_events row review.paused', async () => {
    const { sessionId } = await startReviewSession(db);
    await pauseReviewSession(db, sessionId);
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'review.paused')).toBeTruthy();
    await cleanup(sessionId);
  });

  it('rejects pause-when-already-paused (409)', async () => {
    const { sessionId } = await startReviewSession(db);
    await pauseReviewSession(db, sessionId);
    await expect(pauseReviewSession(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });

  it('rejects pause-after-complete (409)', async () => {
    const { sessionId } = await startReviewSession(db);
    await completeReviewSession(db, sessionId);
    await expect(pauseReviewSession(db, sessionId)).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId);
  });

  it('404 when session missing', async () => {
    await expect(pauseReviewSession(db, 'never-existed')).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
  });
});

// ---------- YUK-57: resumeReviewSession ----------

describe('Review.resumeReviewSession', () => {
  it('paused → started + version bump', async () => {
    const { sessionId } = await startReviewSession(db);
    await pauseReviewSession(db, sessionId);
    await resumeReviewSession(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('started');
    expect(rows[0].version).toBe(2);
    await cleanup(sessionId);
  });

  it('writes a job_events row review.resumed', async () => {
    const { sessionId } = await startReviewSession(db);
    await pauseReviewSession(db, sessionId);
    await resumeReviewSession(db, sessionId);
    const jevents = await db.select().from(job_events).where(eq(job_events.business_id, sessionId));
    expect(jevents.find((e) => e.event_type === 'review.resumed')).toBeTruthy();
    await cleanup(sessionId);
  });

  it('rejects resume-when-already-started (409)', async () => {
    const { sessionId } = await startReviewSession(db);
    await expect(resumeReviewSession(db, sessionId)).rejects.toMatchObject({
      code: 'conflict',
      status: 409,
    });
    await cleanup(sessionId);
  });

  it('rejects resume-after-abandon (409)', async () => {
    const { sessionId } = await startReviewSession(db);
    await abandonReviewSession(db, sessionId);
    await expect(resumeReviewSession(db, sessionId)).rejects.toBeInstanceOf(ApiError);
    await cleanup(sessionId);
  });
});

// ---------- YUK-57: paused → completed / abandoned (expanded allowed-from) ----------

describe('Review.completeReviewSession from paused', () => {
  it('paused → completed (sendBeacon close from paused state)', async () => {
    const { sessionId } = await startReviewSession(db);
    await pauseReviewSession(db, sessionId);
    await completeReviewSession(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('completed');
    expect(rows[0].ended_at).toBeTruthy();
    expect(rows[0].version).toBe(2);
    await cleanup(sessionId);
  });
});

describe('Review.abandonReviewSession from paused', () => {
  it('paused → abandoned (orphan cron 6h path from paused)', async () => {
    const { sessionId } = await startReviewSession(db);
    await pauseReviewSession(db, sessionId);
    await abandonReviewSession(db, sessionId);
    const rows = await db.select().from(learning_session).where(eq(learning_session.id, sessionId));
    expect(rows[0].status).toBe('abandoned');
    expect(rows[0].ended_at).toBeTruthy();
    await cleanup(sessionId);
  });
});
