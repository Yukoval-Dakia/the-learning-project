import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

import { assertFromState } from './guards';

// LearningSession.Review.* — Phase 1c.1 Step 5 minimal state envelope.
//
// State machine (ADR-0008):
//   started → completed | abandoned
//
// Review sessions in Phase 1c.1 are state envelopes only. Per-question review
// events (FSRS rating + state) are written by the review route in Step 6 using
// `writeEvent` directly with session_id chained back to this session. NO domain
// event writes happen inside these transitions — they are purely state-tracking.
//
// Per-transition `job_events` are emitted for SSE / observability parity with
// IngestionSession, using business_table='learning_session' (no legacy table
// name continuity needed since review sessions are new in 1c.1).

const SESSION_TABLE = 'learning_session' as const;

async function loadReviewSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string } | null> {
  const rows = await tx.execute(
    sql`SELECT status FROM learning_session WHERE id = ${sessionId} AND type = 'review' FOR UPDATE`,
  );
  const arr = rows as unknown as Array<{ status: string }>;
  const row = arr[0];
  if (!row) return null;
  return { status: row.status };
}

// ---------- startReviewSession ----------

export type StartReviewSessionParams = {
  /** Optional Phase 1d goal linkage. */
  goalId?: string | null;
};

/**
 * Create a fresh review session (type='review', status='started').
 *
 * @returns the new sessionId. Caller (route layer) writes per-question review
 *   events with session_id=<this id> through writeEvent.
 */
export async function startReviewSession(
  db: Db,
  params: StartReviewSessionParams = {},
): Promise<{ sessionId: string }> {
  return db.transaction(async (tx) => {
    const sessionId = createId();
    const now = new Date();
    await tx.insert(learning_session).values({
      id: sessionId,
      type: 'review',
      status: 'started',
      source_document_id: null,
      source_asset_ids: [],
      entrypoint: null,
      warnings: [],
      error_message: null,
      summary_md: null,
      goal_id: params.goalId ?? null,
      started_at: now,
      created_at: now,
      updated_at: now,
      version: 0,
    });

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'review.started',
      payload: {},
    });

    return { sessionId };
  });
}

// ---------- completeReviewSession ----------

/**
 * started → completed. Sets ended_at = now and bumps version.
 */
export async function completeReviewSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadReviewSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} (type=review) not found`, 404);
    }
    assertFromState(
      current.status,
      ['started'] as const,
      sessionId,
      'Review.completeReviewSession',
    );

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'completed',
        ended_at: now,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'review.completed',
      payload: {},
    });
  });
}

// ---------- abandonReviewSession ----------

/**
 * started → abandoned. Sets ended_at = now and bumps version.
 *
 * Distinct from `completed` so the timeline UI can show "session you walked
 * away from" separately from "session you finished". No data loss; events
 * already written stay chained.
 */
export async function abandonReviewSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadReviewSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} (type=review) not found`, 404);
    }
    assertFromState(
      current.status,
      ['started'] as const,
      sessionId,
      'Review.abandonReviewSession',
    );

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'abandoned',
        ended_at: now,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'review.abandoned',
      payload: {},
    });
  });
}
