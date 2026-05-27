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
// YUK-56 (2026-05-24): wire `JudgeInvoker` (CC-3) for auto-rating. When the
// caller submits `response_md`, run the judge and embed the result in the
// review event's `payload.judge` (mirrors embedded-check pattern). When
// `auto_rate: true`, the suggested rating wins over body.rating. CC-1: this
// route never writes `experimental:user_cause` — rating-only overrides do not
// signal cause disagreement.
//
// Wire JSON shape preserved: { next_due_at, new_state, review_event }.
// The `review_event` field shape changes (now an event row, not a
// review_event row); `id` semantics shift from review_event.id → event.id.

import { z } from 'zod';

import { newId } from '@/core/ids';
import { ActivityRef } from '@/core/schema/activity';
import { FsrsRating } from '@/core/schema/business';
import { JudgeResultV2, type JudgeResultV2T } from '@/core/schema/capability';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { effectiveCauseCategoryForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttempts, writeEvent } from '@/server/events/queries';
import { getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { normalizeReviewSubmitActivityRef } from '@/server/review/activity-ref';
import { activeEffectiveTruth } from '@/server/review/effective-truth';
import { scheduleReview } from '@/server/review/fsrs';
import { ratingFromCoarseOutcome } from '@/server/review/judge-rating';
import { judgeResultToRatingAdvice } from '@/server/review/rating-advisor';
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
  // YUK-56 — when true, the judge runs and its suggested rating (mapped from
  // coarse_outcome) overrides `rating`. Requires `response_md` non-empty.
  // Rejects with 422 when the judge returns coarse_outcome='unsupported'.
  auto_rate: z.boolean().default(false),
  // YUK-98 (T-RA, 2026-05-27) — optional client-supplied judge result. When the
  // UI has already run a judge in the prior /judge step it can submit the
  // result back here so the advisory derivation (rating-advisor.ts) gets a
  // trace and the event payload retains `judge_advice` for later analysis.
  // Old clients that don't send this field still work — advisor stays silent.
  // The route NEVER auto-commits the advisory rating: `body.rating` remains
  // the source-of-truth (advisor is informational; user override wins per
  // YUK-98 driver §1.1).
  judge_result_v2: JudgeResultV2.optional(),
});

type Rating = z.infer<typeof FsrsRating>;

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

    // Confirm the question exists + load full row for judge (YUK-56). The
    // judge needs kind / prompt_md / reference_md / rubric_json / choices_md /
    // judge_kind_override / knowledge_ids / metadata / figures / image_refs /
    // structured — i.e. everything in the question table.
    const qRows = await db.select().from(question).where(eq(question.id, questionId)).limit(1);
    const q = qRows[0];
    if (!q) {
      throw new ApiError('not_found', `question ${questionId} not found`, 404);
    }

    // YUK-56/YUK-98 — Resolve the judge result BEFORE the FSRS transaction.
    // If the UI already generated advice, reuse its `judge_result_v2` so final
    // submit doesn't call the judge twice. Otherwise, run the read-only judge
    // outside the txn (no events written). We need the result up-front to:
    //   1. Decide final rating when auto_rate=true (suggested wins).
    //   2. Reject 422 when auto_rate=true but judge returned 'unsupported'.
    //   3. Embed result in review event's payload.judge.
    //
    // CC-3 invariant: route through `createDefaultJudgeInvoker()`; never call
    // `judgeExact` / `judgeKeyword` / `judgeRouter` directly.
    const answerMd = body.response_md?.trim() ?? '';
    const suppliedJudgeResult = answerMd.length > 0 ? (body.judge_result_v2 ?? null) : null;
    let judgeResult: JudgeResultV2T | null = suppliedJudgeResult;
    let judgeRoute: string | null = suppliedJudgeResult?.capability_ref.id ?? null;
    let judgeTelemetry:
      | Awaited<ReturnType<ReturnType<typeof createDefaultJudgeInvoker>['invoke']>>['telemetry']
      | null = null;
    if (answerMd.length > 0 && judgeResult === null) {
      const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);
      const invoked = await createDefaultJudgeInvoker().invoke({
        db,
        question: q,
        answer_md: answerMd,
        subjectProfile,
      });
      judgeResult = invoked.result;
      judgeRoute = invoked.route;
      judgeTelemetry = invoked.telemetry;
    }

    // YUK-100 (W-05) — Resolve effective cause for the latest active failure
    // attempt on this question so the advisor's partial-credit lean (driver
    // T-RA §1.1: carelessness → 'good' / conceptual → 'again') actually fires
    // in production. We read OUTSIDE the FSRS transaction because:
    //   - This route writes a `review` event (not an `attempt`); the cause
    //     SoT being read belongs to a prior attempt on this question.
    //   - Cause is advisory only — it does not affect FSRS scheduling — so it
    //     does not need FSRS-row serialisation.
    //   - Reading inside the txn would extend lock-hold time pointlessly.
    // CC-1 invariant: this route never classifies cause itself. It only reads
    // the helper output. `causeCategory = null` is a legal fallback when the
    // question has no prior failure attempt or no attached cause.
    const recentFailuresForCause = await getFailureAttempts(db, {
      questionIds: [questionId],
      limit: 1,
    });
    const adviceCauseCategory =
      recentFailuresForCause.length > 0
        ? effectiveCauseCategoryForFailureAttempt(recentFailuresForCause[0])
        : null;

    // YUK-56 — Resolve final rating. In auto_rate mode the judge's suggested
    // rating overrides body.rating. If the judge can't auto-rate (unsupported,
    // or no answer was submitted), reject 422 so the UI falls back to manual.
    const suggestedRating =
      judgeResult !== null ? ratingFromCoarseOutcome(judgeResult.coarse_outcome) : null;
    let finalRating: Rating = body.rating;
    if (body.auto_rate) {
      if (suggestedRating === null) {
        // Either no answer submitted, or judge returned 'unsupported'.
        throw new ApiError(
          'unsupported_judge_route',
          answerMd.length === 0
            ? 'auto_rate requires response_md to be non-empty'
            : `judge route '${judgeRoute}' returned coarse_outcome='unsupported'; please rate manually`,
          422,
        );
      }
      finalRating = suggestedRating;
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
    const outcome: 'success' | 'failure' = finalRating === 'again' ? 'failure' : 'success';
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
          finalRating,
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

      // YUK-56 — Embed judge result on the review event's payload (mirrors
      // embedded-check pattern at app/api/embedded-check/attempt/route.ts:122).
      // Extra keys are stored via jsonb; ReviewOnQuestion Zod schema strips
      // unknown keys on parse, but writeEvent inserts the raw input.payload.
      //
      // Why not a separate action='judge' event chained via caused_by?
      // JudgeOnEvent requires payload.cause (cause attribution is a downstream
      // 'attribution' agent's job; this route only writes the assessment
      // trail). Embedding mirrors the embedded-check pattern and keeps the
      // judge event channel clean for cause-bearing events.
      const judgePayload =
        judgeResult !== null && judgeRoute !== null
          ? {
              judge: {
                route: judgeRoute,
                score: judgeResult.score,
                coarse_outcome: judgeResult.coarse_outcome,
                confidence: judgeResult.confidence,
                feedback_md: judgeResult.feedback_md,
                evidence_json: judgeResult.evidence_json,
                capability_ref: judgeResult.capability_ref,
                suggested_rating: suggestedRating,
                auto_rated: body.auto_rate,
                ...(judgeTelemetry !== null ? { telemetry: judgeTelemetry } : {}),
              },
            }
          : {};

      // YUK-98 (T-RA) — Derive the partial-credit rating advisory from
      // whichever judge result is available (client-supplied OR server-run),
      // and persist it on the event payload as `judge_advice`. Informational
      // only: the user's `body.rating` is still the committed rating (advisor
      // never overrides). CC-1 invariant: this route does not classify cause
      // itself — it reads the SoT helper output via
      // `effectiveCauseCategoryForFailureAttempt()` (resolved above as
      // `adviceCauseCategory`) and threads it into the advisor so the
      // partial-credit carelessness/conceptual lean fires.
      //
      // YUK-100 (W-05): pre-fix this wiring was inert because the advisor's
      // `causeLean()` always saw `undefined`.
      // YUK-101 (iter2 fix F1): pre-iter2 the gate was on `suppliedJudgeResult`
      // (client-supplied only). When the server ran its own judge (no
      // `judge_result_v2` in the body), `judgeAdvicePayload` was `{}` and the
      // cause-aware advisor stayed dead for every server-judge caller — the
      // same class of silent dead path YUK-100 set out to fix. Gate now keys
      // on `judgeResult !== null` so both paths persist judge_advice.
      // See `docs/audit/2026-05-27-wave1-postship-drift.md` §W-05.
      const judgeAdvicePayload = judgeResult !== null
        ? {
            judge_advice: {
              ...judgeResultToRatingAdvice(judgeResult, {
                causeCategory: adviceCauseCategory,
              }),
              source_capability_ref: judgeResult.capability_ref,
              source_coarse_outcome: judgeResult.coarse_outcome,
            },
          }
        : {};

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
          fsrs_rating: finalRating,
          fsrs_state_after: fsrsStateAfter,
          user_response_md: body.response_md ?? null,
          referenced_knowledge_ids: body.referenced_knowledge_ids,
          // Wire `latency_ms` from the UI lands here as `duration_ms` per the
          // ReviewOnQuestion Zod schema (2026-05-17). Optional — omitted for
          // legacy callers that never sent it.
          ...(typeof body.latency_ms === 'number' ? { duration_ms: body.latency_ms } : {}),
          ...judgePayload,
          ...judgeAdvicePayload,
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
    //
    // YUK-56 — additive `judge` field carries auto-rating provenance + the
    // suggested_rating so the UI can highlight which button corresponds to
    // the judge suggestion. `judge` is null when no answer was submitted
    // (manual-only path).
    const judgeResponse =
      judgeResult !== null && judgeRoute !== null
        ? {
            route: judgeRoute,
            score: judgeResult.score,
            coarse_outcome: judgeResult.coarse_outcome,
            confidence: judgeResult.confidence,
            feedback_md: judgeResult.feedback_md,
            evidence_json: judgeResult.evidence_json,
            capability_ref: judgeResult.capability_ref,
            suggested_rating: suggestedRating,
            auto_rated: body.auto_rate,
            ...(judgeTelemetry !== null ? { telemetry: judgeTelemetry } : {}),
          }
        : null;

    return Response.json({
      next_due_at: Math.floor(finalResult.dueAt.getTime() / 1000),
      new_state: finalResult.nextState,
      review_event: {
        id: eventId,
        activity_ref: identity.activity_ref,
        question_id: questionId,
        rating: finalRating,
        response_md: body.response_md ?? null,
        latency_ms: body.latency_ms ?? null,
        fsrs_state_after: finalFsrsStateAfter,
        due_at_next: finalResult.dueAt,
        created_at: now,
        correction_state: activeEffectiveTruth(eventId),
      },
      judge: judgeResponse,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
