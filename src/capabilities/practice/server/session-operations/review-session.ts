// YUK-1570 — review-session lifecycle port for the HTTP adapters in
// capabilities/practice/api/. The operations below own every decision the
// route files used to re-know one by one: which Review member implements a
// transition, the paper-frozen reopen wrapper, the close → session_summary
// dispatch contract (env-gated, best-effort), creation dispatch between the
// FSRS and paper-bound flows, and the detail read's type filter + not-found
// error. api/* keeps Request parsing (sendBeacon tolerance included), schema
// validation, and Response/deprecation shaping.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { artifact, learning_session } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { getStartedBoss } from '@/server/boss/client';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import { Review } from '@/server/session';
import {
  assertIssuedPaperSlotsRenderable,
  assertPaperOpenable,
  issuePaperAssessment,
  readPaperAssessmentBinding,
} from '../assessment/paper-issuance';
import { withFrozenPaperReopen } from '../assessment/paper-session-transition';
import { isPaperIntentSource } from '../paper-intent-sources';

// ---------- summary dispatch contract (moved from api/session-end.ts) ----------

export async function enqueueReviewSessionSummary(sessionId: string): Promise<void> {
  // Best-effort: closing the session succeeds even when pg-boss is unavailable.
  if (!shouldEnqueueBackgroundJobs()) return;
  try {
    const boss = await getStartedBoss();
    await boss.send('session_summary', { session_id: sessionId });
  } catch (err) {
    console.warn(`session_summary enqueue failed for ${sessionId}:`, err);
  }
}

// ---------- simple transitions (legacy routes) ----------

export async function pauseReviewSession(sessionId: string): Promise<void> {
  await Review.pauseReviewSession(db, sessionId);
}

export async function resumeReviewSession(sessionId: string): Promise<void> {
  await Review.resumeReviewSession(db, sessionId);
}

/** abandoned → started, wrapped in the paper-frozen reopen transaction (YUK-63). */
export async function reopenReviewSession(sessionId: string): Promise<void> {
  await withFrozenPaperReopen(db, sessionId, (tx) =>
    Review.reopenAbandonedReviewSession(tx, sessionId),
  );
}

// ---------- close (legacy sendBeacon-tolerant end route) ----------

export async function closeReviewSession(
  sessionId: string,
  status: 'completed' | 'abandoned',
): Promise<void> {
  if (status === 'completed') {
    await Review.completeReviewSession(db, sessionId);
    // Enqueue async SessionSummaryTask (Phase 1d). Best-effort: if pg-boss
    // is down the session still closes successfully and summary stays null
    // (the /learning-sessions/[id] UI shows a stub in that case).
    //
    // Skipped in tests via the shared shouldEnqueueBackgroundJobs() (YUK-239)
    // — the singleton boss instance + per-route invocation bloats the
    // testcontainer's connection pool past max_connections, tipping over
    // src/server/boss/client.test.ts. The summary handler is covered by its
    // own unit test (src/server/session/summary.test.ts).
    await enqueueReviewSessionSummary(sessionId);
  } else {
    await Review.abandonReviewSession(db, sessionId);
  }
}

// ---------- idempotent transition (canonical PATCH route) ----------

export async function transitionReviewSession(
  sessionId: string,
  target: Review.ReviewSessionStatus,
): Promise<Review.ReviewSessionTransition> {
  const transition = await withFrozenPaperReopen(
    db,
    sessionId,
    (tx) => Review.transitionReviewSession(tx, sessionId, target),
    target === 'started',
  );
  if (transition.changed && transition.status === 'completed') {
    await enqueueReviewSessionSummary(sessionId);
  }
  return transition;
}

// ---------- creation ----------

export interface PaperReviewSessionResult {
  sessionId: string;
  created: boolean;
}

/** Dispatch session creation: paper-bound flow when a paper id was supplied. */
export async function createReviewSession(input: {
  paperId?: string;
}): Promise<PaperReviewSessionResult> {
  if (input.paperId) return createPaperReviewSession(input.paperId);
  const { sessionId } = await Review.startReviewSession(db);
  return { sessionId, created: true };
}

/** Validate a paper and create or reuse its active review session. */
export async function createPaperReviewSession(paperId: string): Promise<PaperReviewSessionResult> {
  return db.transaction(async (tx) => {
    // A row lock cannot serialize the "no active session exists" case. Use a
    // transaction-scoped lock keyed by paper so concurrent creates cannot both
    // pass the empty lookup and insert separate active sessions.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`paper-review-session:${paperId}`}, 0))`,
    );

    const artifactRows = await tx
      .select({
        id: artifact.id,
        type: artifact.type,
        generation_status: artifact.generation_status,
        intent_source: artifact.intent_source,
      })
      .from(artifact)
      .where(eq(artifact.id, paperId))
      .limit(1);
    const paper = artifactRows[0];
    if (!paper) {
      throw new ApiError('not_found', `artifact ${paperId} not found`, 404);
    }
    if (paper.type !== 'tool_quiz') {
      throw new ApiError(
        'validation_error',
        `artifact ${paperId} is not a practice paper (type=${paper.type})`,
        400,
      );
    }
    if (paper.generation_status !== 'ready') {
      throw new ApiError(
        'validation_error',
        `artifact ${paperId} is not ready (generation_status=${paper.generation_status})`,
        400,
      );
    }
    if (!isPaperIntentSource(paper.intent_source)) {
      throw new ApiError(
        'validation_error',
        `artifact ${paperId} is not a practice paper (intent_source=${paper.intent_source})`,
        400,
      );
    }

    const existingSessionRows = await tx
      .select({ id: learning_session.id })
      .from(learning_session)
      .where(
        and(
          eq(learning_session.type, 'review'),
          eq(learning_session.artifact_id, paperId),
          inArray(learning_session.status, ['started', 'paused']),
        ),
      )
      .orderBy(desc(learning_session.created_at))
      .limit(1);
    if (existingSessionRows[0]) {
      // YUK-1573 — an occurrence opened before the whole-paper guard is not handed back
      // to the paper page when its issued slots include ones the page cannot render.
      const binding = await readPaperAssessmentBinding(tx, existingSessionRows[0].id);
      if (binding) {
        await assertIssuedPaperSlotsRenderable(
          tx,
          paperId,
          binding.slots.map((slot) => slot.issuance_id),
        );
      }
      return { sessionId: existingSessionRows[0].id, created: false };
    }

    // YUK-1573 — read-only refusal before the session row and any issuance are written.
    await assertPaperOpenable(tx, paperId);
    const { sessionId } = await Review.startReviewSession(tx, { artifactId: paperId });
    await issuePaperAssessment(tx, sessionId, paperId);
    return { sessionId, created: true };
  });
}

// ---------- detail read ----------

export async function readReviewSession(sessionId: string) {
  const rows = await db
    .select({
      id: learning_session.id,
      type: learning_session.type,
      status: learning_session.status,
      paper_id: learning_session.artifact_id,
      started_at: learning_session.started_at,
      ended_at: learning_session.ended_at,
      updated_at: learning_session.updated_at,
    })
    .from(learning_session)
    .where(and(eq(learning_session.id, sessionId), eq(learning_session.type, 'review')))
    .limit(1);
  const session = rows[0];
  if (!session) {
    throw new ApiError('not_found', `review session ${sessionId} not found`, 404);
  }
  return session;
}
