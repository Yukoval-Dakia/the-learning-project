// Phase 1c.1 Step 9.A — `/api/review/submit` rewritten over the event stream.
//
// Pre-Step-9: read mistake.fsrs_state → schedule → INSERT review_event +
//   UPDATE mistake.fsrs_state under optimistic lock.
//
// Post-Step-9:
//   1. Resolve review identity through ActivityRef first, with `question_id`
//      and `mistake_id` accepted only by the compatibility shim.
//   2. Read latest material_fsrs_state for that question.
//   3. Compute next FSRS state via ts-fsrs.
//   4. Write a `review` event (action='review', subject='question') via
//      writeEvent (single-owner per ADR-0005).
//   5. Upsert material_fsrs_state via upsertFsrsState (single-owner per
//      Step 9.A new module).
//
// Wire JSON shape preserved: { next_due_at, new_state, review_event }.
// The `review_event` field shape changes (now an event row, not a
// review_event row); `id` semantics shift from review_event.id → event.id.

import { z } from 'zod';

import { newId } from '@/core/ids';
import { ActivityRef } from '@/core/schema/activity';
import { FsrsRating } from '@/core/schema/business';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError, errorResponse } from '@/server/http/errors';
import { normalizeReviewSubmitActivityRef } from '@/server/review/activity-ref';
import { activeEffectiveTruth } from '@/server/review/effective-truth';
import { scheduleReview } from '@/server/review/fsrs';
import { eq, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

// New callers send `activity_ref`. `question_id` and `mistake_id` are accepted
// only as compatibility inputs while the storage/policy layer remains backed by
// question rows.
const SubmitBody = z.object({
  activity_ref: ActivityRef.optional(),
  question_id: z.string().min(1).optional(),
  mistake_id: z.string().min(1).optional(),
  rating: FsrsRating,
  response_md: z.string().nullable().optional(),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
  // ADR-0013 — optional review session id; UI passes the session created on
  // /review mount. server falls back to null when absent for backwards compat.
  session_id: z.string().min(1).nullable().optional(),
  // ADR-0012 — review events feed the derived knowledge_mastery view.
  referenced_knowledge_ids: z.array(z.string().min(1)).default([]),
});

export async function POST(req: Request): Promise<Response> {
  try {
    const raw = await req.json().catch(() => null);
    const parsed = SubmitBody.safeParse(raw);
    if (!parsed.success) {
      const message = parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      throw new ApiError('validation_error', message, 400);
    }
    const body = parsed.data;
    const now = new Date();
    const identity = normalizeReviewSubmitActivityRef(body);
    const questionId = identity.question_id;

    // Confirm the question exists; otherwise the review is for nothing.
    const qRows = await db
      .select({ id: question.id })
      .from(question)
      .where(eq(question.id, questionId))
      .limit(1);
    if (qRows.length === 0) {
      throw new ApiError('not_found', `question ${questionId} not found`, 404);
    }

    // Codex P1-G — FSRS read + compute + write must all share a transaction
    // serialised by SELECT … FOR UPDATE on the question row. Pre-fix the read
    // ran outside the txn so two concurrent submits saw the same prior state
    // and the later upsert produced torn FSRS state (e.g., both saw reps=0
    // and wrote reps=1; lost the second review's effect).
    //
    // We lock the question row (always exists since we just checked above)
    // even when no material_fsrs_state row exists yet — first-review case
    // would otherwise race on the unique constraint and only one write would
    // survive, dropping the other's effect.
    const outcome: 'success' | 'failure' = body.rating === 'again' ? 'failure' : 'success';
    const eventId = newId();
    let result: ReturnType<typeof scheduleReview>;
    let fsrsStateAfter: ReturnType<typeof scheduleReview>['nextState'] & {
      last_review: Date | null;
    };

    await db.transaction(async (tx) => {
      // SELECT … FOR UPDATE on the question row — concurrent reviewers
      // serialise on this lock, so the second read sees the first's
      // committed FSRS projection.
      await tx.execute(sql`SELECT id FROM question WHERE id = ${questionId} FOR UPDATE`);

      let prevStateRow: Awaited<ReturnType<typeof getFsrsState>> = null;
      try {
        prevStateRow = await getFsrsState(tx, 'question', questionId);
        result = scheduleReview(
          prevStateRow?.state
            ? {
                ...prevStateRow.state,
                last_review: prevStateRow.state.last_review ?? null,
              }
            : null,
          body.rating,
          now,
        );
      } catch (err) {
        console.error('review submit prep failed', { questionId, err });
        throw new ApiError(
          'corrupt_state',
          `material_fsrs_state for question ${questionId} could not be parsed; please reset this card`,
          422,
        );
      }

      fsrsStateAfter = {
        ...result.nextState,
        due: result.nextState.due,
        last_review: result.nextState.last_review ?? null,
      };

      await writeEvent(tx, {
        id: eventId,
        session_id: body.session_id ?? null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: questionId,
        outcome,
        payload: {
          fsrs_rating: body.rating,
          fsrs_state_after: fsrsStateAfter,
          user_response_md: body.response_md ?? null,
          referenced_knowledge_ids: body.referenced_knowledge_ids,
          // Wire `latency_ms` from the UI lands here as `duration_ms` per the
          // ReviewOnQuestion Zod schema (2026-05-17). Optional — omitted for
          // legacy callers that never sent it.
          ...(typeof body.latency_ms === 'number' ? { duration_ms: body.latency_ms } : {}),
        },
        caused_by_event_id: null,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
      await upsertFsrsState(tx, {
        subject_kind: 'question',
        subject_id: questionId,
        state: fsrsStateAfter,
        due_at: result.dueAt,
        last_review_event_id: eventId,
      });
    });
    // After the txn: result + fsrsStateAfter were assigned inside; assert
    // non-null for TS narrowing (txn either commits and assigns, or throws).
    // biome-ignore lint/style/noNonNullAssertion: assigned inside the txn
    const finalResult = result!;
    // biome-ignore lint/style/noNonNullAssertion: assigned inside the txn
    const finalFsrsStateAfter = fsrsStateAfter!;

    // Response shape kept: review_event is now the event row (shape changed
    // but documented as opaque to clients).
    return Response.json({
      next_due_at: Math.floor(finalResult.dueAt.getTime() / 1000),
      new_state: finalResult.nextState,
      review_event: {
        id: eventId,
        activity_ref: identity.activity_ref,
        question_id: questionId,
        rating: body.rating,
        response_md: body.response_md ?? null,
        latency_ms: body.latency_ms ?? null,
        fsrs_state_after: finalFsrsStateAfter,
        due_at_next: finalResult.dueAt,
        created_at: now,
        correction_state: activeEffectiveTruth(eventId),
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
