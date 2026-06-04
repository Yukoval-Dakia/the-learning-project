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
import { enqueueMasteryNoteRefine } from '@/server/artifacts/note-refine-triggers';
import { writeEvent } from '@/server/events/queries';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { ApiError, errorResponse } from '@/server/http/errors';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { normalizeReviewSubmitActivityRef } from '@/server/review/activity-ref';
import { resolveAdviceCauseForQuestion } from '@/server/review/cause-context';
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

    // YUK-100 (W-05) + YUK-101 (iter2 F8 / F13) — Resolve effective cause via
    // the shared `resolveAdviceCauseForQuestion` helper. It scans the recent
    // failure-attempt window and folds `effectiveCauseCategoryForFailureAttempt`
    // (CC-1 single-owner — active user_cause wins over latest active agent
    // judge) until it finds a non-null cause. Read happens OUTSIDE the FSRS
    // transaction because cause is advisory only (no FSRS scheduling impact)
    // and reading inside would extend lock-hold time pointlessly.
    //
    // CC-1 invariant preserved: this route never classifies cause itself; it
    // only reads the helper output. `null` is a legal fallback when no recent
    // failure within the scan window carries a cause.
    const adviceCauseCategory = await resolveAdviceCauseForQuestion(db, questionId);

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

    const referencedKnowledgeIds = Array.from(
      new Set(
        (body.referenced_knowledge_ids.length > 0 ? body.referenced_knowledge_ids : q.knowledge_ids)
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    );
    const fsrsSubjectKind: FsrsSubjectKind =
      referencedKnowledgeIds.length > 0 ? 'knowledge' : 'question';
    const fsrsSubjectIds = fsrsSubjectKind === 'knowledge' ? referencedKnowledgeIds : [questionId];

    // P3 / YUK-203 — FSRS is now scheduled per knowledge point when the reviewed
    // question is knowledge-labeled. The review event remains question-scoped
    // because the user answered a concrete question, but the projection row is
    // keyed by `(subject_kind='knowledge', subject_id=<knowledge_id>)`.
    //
    // Concurrency: locking only the question row is no longer sufficient because
    // two different questions may update the same knowledge FSRS state. A
    // transaction-scoped advisory lock per FSRS subject serializes read/compute/
    // upsert even when the projection row does not exist yet.
    const outcome: 'success' | 'failure' = finalRating === 'again' ? 'failure' : 'success';
    const eventId = newId();
    let primaryResult: ReturnType<typeof scheduleReview>;
    let primaryFsrsStateAfter: ReturnType<typeof scheduleReview>['nextState'] & {
      last_review: Date | null;
    };

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM question WHERE id = ${questionId} FOR UPDATE`);

      const fsrsUpdates: Array<{
        subject_kind: FsrsSubjectKind;
        subject_id: string;
        result: ReturnType<typeof scheduleReview>;
        stateAfter: ReturnType<typeof scheduleReview>['nextState'] & {
          last_review: Date | null;
        };
      }> = [];

      for (const subjectId of [...fsrsSubjectIds].sort()) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${fsrsSubjectKind}:${subjectId}`}))`,
        );
      }

      for (const subjectId of fsrsSubjectIds) {
        let prevStateRow: Awaited<ReturnType<typeof getFsrsState>> = null;
        let result: ReturnType<typeof scheduleReview>;
        try {
          prevStateRow = await getFsrsState(tx, fsrsSubjectKind, subjectId);
          if (!prevStateRow && fsrsSubjectKind === 'knowledge') {
            prevStateRow = await getFsrsState(tx, 'question', questionId);
          }
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
          console.error('review submit prep failed', {
            questionId,
            fsrsSubjectKind,
            fsrsSubjectId: subjectId,
            err,
          });
          throw new ApiError(
            'corrupt_state',
            `material_fsrs_state for ${fsrsSubjectKind} ${subjectId} could not be parsed; please reset this card`,
            422,
          );
        }

        fsrsUpdates.push({
          subject_kind: fsrsSubjectKind,
          subject_id: subjectId,
          result,
          stateAfter: {
            ...result.nextState,
            due: result.nextState.due,
            last_review: result.nextState.last_review ?? null,
          },
        });
      }
      const primaryUpdate = fsrsUpdates[0];
      primaryResult = primaryUpdate.result;
      primaryFsrsStateAfter = primaryUpdate.stateAfter;

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
      const judgeAdvicePayload =
        judgeResult !== null
          ? {
              judge_advice: {
                ...judgeResultToRatingAdvice(judgeResult, {
                  causeCategory: adviceCauseCategory,
                }),
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
          fsrs_subject_kind: fsrsSubjectKind,
          fsrs_subject_ids: fsrsSubjectIds,
          fsrs_state_after: primaryFsrsStateAfter,
          fsrs_state_after_by_subject: fsrsUpdates.map((update) => ({
            subject_kind: update.subject_kind,
            subject_id: update.subject_id,
            state: update.stateAfter,
            due_at: update.result.dueAt,
          })),
          user_response_md: body.response_md ?? null,
          referenced_knowledge_ids: referencedKnowledgeIds,
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
      for (const update of fsrsUpdates) {
        await upsertFsrsState(tx, {
          subject_kind: update.subject_kind,
          subject_id: update.subject_id,
          state: update.stateAfter,
          due_at: update.result.dueAt,
          last_review_event_id: eventId,
        });
      }
    });
    // After the txn: primaryResult + primaryFsrsStateAfter were assigned inside; assert
    // non-null for TS narrowing (txn either commits and assigns, or throws).
    // biome-ignore lint/style/noNonNullAssertion: assigned inside the txn
    const finalResult = primaryResult!;
    // biome-ignore lint/style/noNonNullAssertion: assigned inside the txn
    const finalFsrsStateAfter = primaryFsrsStateAfter!;

    if (outcome === 'success' && q.source_ref) {
      await enqueueMasteryNoteRefine({
        db,
        artifactId: q.source_ref,
        questionId,
        triggerEventId: eventId,
      });
    }

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
        fsrs_subject_kind: fsrsSubjectKind,
        fsrs_subject_ids: fsrsSubjectIds,
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
