import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { event, learning_session } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import { writeJobEvent } from '@/server/events/writer';

import { assertFromState } from './guards';

// LearningSession.Review.* — Phase 1c.1 Step 5 minimal state envelope.
//
// State machine (ADR-0008 + YUK-57 expansion):
//   started ⇄ paused
//        ↘ ↙     ↑
//      completed | abandoned
//                  ↳ reopened → started (YUK-63)
//
// YUK-57: paused is a transient user state from /review. Both started and paused
// are "live": the 6h orphan cron sweeps both, and complete/abandon can end either.
//
// These are state envelopes only. Per-question review events (FSRS rating + state)
// are written by the review route; these transitions never grade. Completion
// releases buffered native feedback in the same transaction, so it is visible only
// once the session is really over.
//
// job_events are emitted for SSE / observability parity with IngestionSession.

const SESSION_TABLE = 'learning_session' as const;

async function loadReviewSessionForUpdate(
  tx: Db | Tx,
  sessionId: string,
): Promise<{ status: string; started_at: string | Date; version: number } | null> {
  const rows = await tx.execute<{ status: string; started_at: string | Date; version: number }>(
    sql`SELECT status, started_at, version FROM learning_session WHERE id = ${sessionId} AND type = 'review' FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) return null;
  return { status: row.status, started_at: row.started_at, version: row.version };
}

export type OrphanReviewCandidate = {
  sessionId: string;
  selectedStartedAt: string;
  selectedVersion: number;
};
export type OrphanReviewResult =
  | { kind: 'abandoned'; fromVersion: number; toVersion: number }
  | { kind: 'skipped'; reason: 'missing' | 'terminal' | 'reopened' | 'not-old' };

/** Caller retains the row lock through its receipt commit. Version is evidence, not a CAS. */
export async function abandonOrphanReviewSession(
  tx: Tx,
  input: { candidate: OrphanReviewCandidate; cutoff: Date | string },
): Promise<OrphanReviewResult> {
  const { candidate, cutoff } = input;
  const current = await loadReviewSessionForUpdate(tx, candidate.sessionId);
  if (!current) return { kind: 'skipped', reason: 'missing' };
  if (current.status !== 'started' && current.status !== 'paused')
    return { kind: 'skipped', reason: 'terminal' };
  const [eligibility] = await tx.execute<{ same_incarnation: boolean; old: boolean }>(sql`
    select started_at = ${candidate.selectedStartedAt}::timestamptz as same_incarnation,
      started_at < ${cutoff instanceof Date ? cutoff.toISOString() : cutoff}::timestamptz as old
    from learning_session where id = ${candidate.sessionId}
  `);
  if (!eligibility.same_incarnation) return { kind: 'skipped', reason: 'reopened' };
  if (!eligibility.old) return { kind: 'skipped', reason: 'not-old' };
  await applyReviewSessionTransition(tx, candidate.sessionId, 'abandoned', {
    allowedFrom: ['started', 'paused'],
    idempotent: false,
  });
  return { kind: 'abandoned', fromVersion: current.version, toVersion: current.version + 1 };
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
  db: Db | Tx,
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

    if (target === 'completed') {
      // Raw `execute` returns timestamptz as PG text, while attempt payloads store
      // the ISO form (paper-attempt.ts); normalize before comparing.
      const paperStartedAt = new Date(current.started_at).toISOString();
      const attempts = await tx
        .select()
        .from(event)
        .where(
          and(
            eq(event.session_id, sessionId),
            eq(event.action, 'experimental:assessment_attempt'),
            sql`${event.payload}->>'paper_feedback_policy' = 'judge_now_show_later'`,
            sql`${event.payload}->>'paper_started_at' = ${paperStartedAt}`,
          ),
        );
      for (const attempt of attempts) {
        await writeEvent(tx, {
          id: `feedback_released:${attempt.id}`,
          session_id: sessionId,
          actor_kind: 'system',
          actor_ref: 'review_session',
          action: 'experimental:assessment_feedback_released',
          subject_kind: 'event',
          subject_id: attempt.id,
          caused_by_event_id: attempt.id,
          outcome: null,
          payload: {
            attempt_event_id: attempt.id,
            paper_started_at: paperStartedAt,
          },
          created_at: now,
        });
      }
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
  db: Db | Tx,
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
  /** Optional goal linkage. */
  goalId?: string | null;
  /**
   * U5 (YUK-203) — soft reference to the paper being answered. Null for the
   * FSRS per-card /review flow; loose text ref, no FK.
   */
  artifactId?: string | null;
  /**
   * YUK-535 — server-owned KC scope for on-demand review; persists so reloads can
   * recover the same session without trusting a client-supplied session id.
   */
  scopeKnowledgeIds?: string[] | null;
};

/**
 * Create a fresh review session (type='review', status='started'). The route
 * chains per-question review events to the returned id.
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
      scope_knowledge_ids: params.scopeKnowledgeIds ?? null,
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
 * started|paused → completed. Sets ended_at and bumps version.
 */
export async function completeReviewSession(db: Db, sessionId: string): Promise<void> {
  await applyReviewSessionTransition(db, sessionId, 'completed', {
    allowedFrom: ['started', 'paused'],
    idempotent: false,
  });
}

// ---------- abandonReviewSession ----------

/**
 * started|paused → abandoned. Distinct terminal state so the timeline can show
 * "walked away" separately from "finished"; existing events stay chained.
 */
export async function abandonReviewSession(db: Db, sessionId: string): Promise<void> {
  await applyReviewSessionTransition(db, sessionId, 'abandoned', {
    allowedFrom: ['started', 'paused'],
    idempotent: false,
  });
}

// ---------- pauseReviewSession (YUK-57) ----------

/**
 * started → paused. Transient and does not set ended_at; the 6h orphan cron
 * still abandons old paused sessions.
 */
export async function pauseReviewSession(db: Db, sessionId: string): Promise<void> {
  await applyReviewSessionTransition(db, sessionId, 'paused', {
    allowedFrom: ['started'],
    idempotent: false,
  });
}

// ---------- resumeReviewSession (YUK-57) ----------

/**
 * paused → started. Resumes from /today or `?session=<id>` on /review mount.
 */
export async function resumeReviewSession(db: Db, sessionId: string): Promise<void> {
  await applyReviewSessionTransition(db, sessionId, 'started', {
    allowedFrom: ['paused'],
    idempotent: false,
  });
}

// ---------- reopenAbandonedReviewSession (YUK-63) ----------

/**
 * abandoned → started. Re-bases started_at and clears ended_at because the
 * session is live again; prior review events stay chained by session_id.
 */
export async function reopenAbandonedReviewSession(db: Db | Tx, sessionId: string): Promise<void> {
  await applyReviewSessionTransition(db, sessionId, 'started', {
    allowedFrom: ['abandoned'],
    idempotent: false,
  });
}
