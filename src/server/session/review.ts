import { createId } from '@paralleldrive/cuid2';
import { eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { learning_session } from '@/db/schema';
import { writeJobEvent } from '@/server/events/writer';
import { ApiError } from '@/server/http/errors';

import { assertFromState } from './guards';

// LearningSession.Review.* — Phase 1c.1 Step 5 minimal state envelope.
//
// State machine (ADR-0008 + YUK-57 expansion):
//   started ⇄ paused
//        ↘ ↙     ↑
//      completed | abandoned
//                  ↳ reopened → started (YUK-63)
//
// YUK-57: paused is a user-initiated transient state from /review page. Both
// started and paused are "live" states — orphan cron (6h) sweeps both, and
// sendBeacon close / explicit complete can terminate either.
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
    // YUK-57: completion is allowed from both started AND paused. A paused
    // session that pagehide-fired sendBeacon-end OR cron-sweeps closes via
    // this path; user can also click "complete" from the paused UI.
    assertFromState(
      current.status,
      ['started', 'paused'] as const,
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
    // YUK-57: abandon allowed from started AND paused. Orphan cron (6h)
    // sweeps both; this fn is the single transition point.
    assertFromState(
      current.status,
      ['started', 'paused'] as const,
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

// ---------- pauseReviewSession (YUK-57) ----------

/**
 * started → paused. Pause is a user-initiated transient state from /review.
 * Does NOT set ended_at — the session is still "live" semantically. Version
 * bumps so optimistic-concurrency consumers see the change.
 *
 * sendBeacon on pagehide must skip emit when status='paused' (handled
 * client-side); orphan cron still abandons paused sessions older than 6h.
 */
export async function pauseReviewSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadReviewSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} (type=review) not found`, 404);
    }
    assertFromState(current.status, ['started'] as const, sessionId, 'Review.pauseReviewSession');

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'paused',
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'review.paused',
      payload: {},
    });
  });
}

// ---------- resumeReviewSession (YUK-57) ----------

/**
 * paused → started. Resumes from /today SessionStrip or via `?session=<id>`
 * URL param on /review mount. Version bumps; ended_at stays null (was null
 * during paused too).
 */
export async function resumeReviewSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadReviewSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} (type=review) not found`, 404);
    }
    assertFromState(current.status, ['paused'] as const, sessionId, 'Review.resumeReviewSession');

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'started',
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'review.resumed',
      payload: {},
    });
  });
}

// ---------- reopenAbandonedReviewSession (YUK-63) ----------

/**
 * abandoned → started. Used when the user returns to an orphan-cron-abandoned
 * review session from `/learning-sessions`. Re-bases started_at and clears
 * ended_at because the session is live again; per-question review events remain
 * chained by session_id.
 */
export async function reopenAbandonedReviewSession(db: Db, sessionId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await loadReviewSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} (type=review) not found`, 404);
    }
    assertFromState(
      current.status,
      ['abandoned'] as const,
      sessionId,
      'Review.reopenAbandonedReviewSession',
    );

    const now = new Date();
    await tx
      .update(learning_session)
      .set({
        status: 'started',
        started_at: now,
        ended_at: null,
        updated_at: now,
        version: sql`${learning_session.version} + 1`,
      })
      .where(eq(learning_session.id, sessionId));

    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: 'review.reopened',
      payload: {},
    });
  });
}
