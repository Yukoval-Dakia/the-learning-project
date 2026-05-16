// Phase 1c.1 Step 9.A — `/api/review/submit` rewritten over the event stream.
//
// Pre-Step-9: read mistake.fsrs_state → schedule → INSERT review_event +
//   UPDATE mistake.fsrs_state under optimistic lock.
//
// Post-Step-9:
//   1. Treat `mistake_id` as the question id (opaque to clients; the legacy
//      mistake table is gone, semantics map 1:1 because mistake.question_id
//      was an FK with on-disk equality after the Step 3 migration).
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
import { FsrsRating } from '@/core/schema/business';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError, errorResponse } from '@/server/http/errors';
import { scheduleReview } from '@/server/review/fsrs';
import { eq, sql } from 'drizzle-orm';

export const runtime = 'nodejs';

// `mistake_id` is preserved on the wire for client back-compat; post-Step-9 it
// is semantically the question id (the mistake row is gone). Test fixtures and
// callers may pass either historical mistake ids OR question ids — the only
// constraint is that material_fsrs_state keys on the resolved question id.
const SubmitBody = z.object({
  mistake_id: z.string().min(1),
  rating: FsrsRating,
  response_md: z.string().nullable().optional(),
  latency_ms: z.number().int().min(0).max(3_600_000).nullable().optional(),
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
    const questionId = body.mistake_id;

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
        session_id: null,
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
          referenced_knowledge_ids: [] as string[],
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
        question_id: questionId,
        rating: body.rating,
        response_md: body.response_md ?? null,
        latency_ms: body.latency_ms ?? null,
        fsrs_state_after: finalFsrsStateAfter,
        due_at_next: finalResult.dueAt,
        created_at: now,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
