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

export type ReviewSessionStatus = 'started' | 'paused' | 'completed' | 'abandoned';

export type ReviewSessionTransition = {
  previousStatus: ReviewSessionStatus;
  status: ReviewSessionStatus;
  changed: boolean;
  allowedStatuses: ReviewSessionStatus[];
};

const REVIEW_ALLOWED_TARGETS: Record<ReviewSessionStatus, ReviewSessionStatus[]> = {
  started: ['paused', 'completed', 'abandoned'],
  paused: ['started', 'completed', 'abandoned'],
  completed: [],
  abandoned: ['started'],
};

type ReviewTransitionOptions = {
  allowedFrom: ReviewSessionStatus[];
  idempotent: boolean;
};

async function applyReviewSessionTransition(
  db: Db,
  sessionId: string,
  target: ReviewSessionStatus,
  options: ReviewTransitionOptions,
): Promise<ReviewSessionTransition> {
  return db.transaction(async (tx) => {
    const current = await loadReviewSessionForUpdate(tx, sessionId);
    if (!current) {
      throw new ApiError('not_found', `learning_session ${sessionId} (type=review) not found`, 404);
    }

    const previousStatus = current.status as ReviewSessionStatus;
    if (previousStatus === target && options.idempotent) {
      return {
        previousStatus,
        status: target,
        changed: false,
        allowedStatuses: REVIEW_ALLOWED_TARGETS[target] ?? [],
      };
    }
    assertFromState(
      current.status,
      options.allowedFrom,
      sessionId,
      `Review.transitionReviewSession(${target})`,
    );

    const now = new Date();
    if (target === 'started' && previousStatus === 'abandoned') {
      await tx
        .update(learning_session)
        .set({
          status: target,
          started_at: now,
          ended_at: null,
          updated_at: now,
          version: sql`${learning_session.version} + 1`,
        })
        .where(eq(learning_session.id, sessionId));
    } else if (target === 'completed' || target === 'abandoned') {
      await tx
        .update(learning_session)
        .set({
          status: target,
          ended_at: now,
          updated_at: now,
          version: sql`${learning_session.version} + 1`,
        })
        .where(eq(learning_session.id, sessionId));
    } else {
      await tx
        .update(learning_session)
        .set({
          status: target,
          updated_at: now,
          version: sql`${learning_session.version} + 1`,
        })
        .where(eq(learning_session.id, sessionId));
    }

    const eventType =
      target === 'started'
        ? previousStatus === 'abandoned'
          ? 'review.reopened'
          : 'review.resumed'
        : `review.${target}`;
    await writeJobEvent(tx, {
      business_table: SESSION_TABLE,
      business_id: sessionId,
      event_type: eventType,
      payload: {},
    });

    return {
      previousStatus,
      status: target,
      changed: true,
      allowedStatuses: REVIEW_ALLOWED_TARGETS[target],
    };
  });
}

/**
 * Idempotently move a review session to a target state for the canonical PATCH route.
 * Replaying the same target returns changed=false and emits no duplicate job event.
 */
export async function transitionReviewSession(
  db: Db,
  sessionId: string,
  target: ReviewSessionStatus,
): Promise<ReviewSessionTransition> {
  const allowedFrom: Record<ReviewSessionStatus, ReviewSessionStatus[]> = {
    started: ['paused', 'abandoned'],
    paused: ['started'],
    completed: ['started', 'paused'],
    abandoned: ['started', 'paused'],
  };
  return applyReviewSessionTransition(db, sessionId, target, {
    allowedFrom: allowedFrom[target],
    idempotent: true,
  });
}

// ---------- startReviewSession ----------

export type StartReviewSessionParams = {
  /** Optional Phase 1d goal linkage. */
  goalId?: string | null;
  /**
   * U5 (YUK-203) — optional soft reference to the paper artifact this review
   * session is taking (the answering page passes it on mount). Null for the
   * FSRS-逐张 /review flow. No FK (Q4) — loose text ref.
   */
  artifactId?: string | null;
};

/**
 * Create a fresh review session (type='review', status='started').
 *
 * @returns the new sessionId. Caller (route layer) writes per-question review
 *   events with session_id=<this id> through writeEvent.
 */
export async function startReviewSession(
  db: Db | Tx,
  params: StartReviewSessionParams = {},
): Promise<{ sessionId: string }> {
  const create = async (tx: Tx): Promise<{ sessionId: string }> => {
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
      artifact_id: params.artifactId ?? null,
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
  };

  // Reuse a caller-owned transaction when present so higher-level idempotency
  // locks cover both the lookup and this insert/event pair.
  if (!('$client' in db)) return create(db);
  return db.transaction(create);
}

// ---------- completeReviewSession ----------

/**
 * started → completed. Sets ended_at = now and bumps version.
 */
export async function completeReviewSession(db: Db, sessionId: string): Promise<void> {
  await applyReviewSessionTransition(db, sessionId, 'completed', {
    allowedFrom: ['started', 'paused'],
    idempotent: false,
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
  await applyReviewSessionTransition(db, sessionId, 'abandoned', {
    allowedFrom: ['started', 'paused'],
    idempotent: false,
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
  await applyReviewSessionTransition(db, sessionId, 'paused', {
    allowedFrom: ['started'],
    idempotent: false,
  });
}

// ---------- resumeReviewSession (YUK-57) ----------

/**
 * paused → started. Resumes from /today SessionStrip or via `?session=<id>`
 * URL param on /review mount. Version bumps; ended_at stays null (was null
 * during paused too).
 */
export async function resumeReviewSession(db: Db, sessionId: string): Promise<void> {
  await applyReviewSessionTransition(db, sessionId, 'started', {
    allowedFrom: ['paused'],
    idempotent: false,
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
  await applyReviewSessionTransition(db, sessionId, 'started', {
    allowedFrom: ['abandoned'],
    idempotent: false,
  });
}
