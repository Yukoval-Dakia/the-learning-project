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
//
// P2a (YUK-312) — split into three phases with identical behavior:
//   validateSubmit (parse + identity + question load) →
//   judgeSubmit (judge routing + rating resolution, all OUTSIDE the txn) →
//   persistSubmit (knowledge-set resolution + FSRS txn + event write + refine
//   trigger). POST composes the phases and shapes the wire response.

import { z } from 'zod';

import { newId } from '@/core/ids';
import { ActivityRef } from '@/core/schema/activity';
import { FsrsRating } from '@/core/schema/business';
import { JudgeResultV2, type JudgeResultV2T } from '@/core/schema/capability';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { enqueueMasteryNoteRefine } from '@/server/artifacts/note-refine-triggers';
import { writeEvent } from '@/server/events/queries';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  resolveQuestionJudgeRoute,
} from '@/server/judge/route-resolve';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';
import { eq, sql } from 'drizzle-orm';
import { normalizeReviewSubmitActivityRef } from '../server/activity-ref';
import { resolveAdviceCauseForQuestion } from '../server/cause-context';
import { activeEffectiveTruth } from '../server/effective-truth';
import { scheduleReview } from '../server/fsrs';
import { ratingFromCoarseOutcome } from '../server/judge-rating';
import { judgeResultToRatingAdvice } from '../server/rating-advisor';

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
  // YUK-215 — handwriting-photo answer refs. Threaded into the judge invoker so
  // a photographed answer is judged on what was written, and frozen into the
  // review event payload (evidence trail). Named `answer_image_refs` to match
  // the event-payload convention (paper attempt payload uses the same key);
  // the paper submit route's body uses `image_refs` — distinct layers, not a
  // conflict (Cross-统合 F-16). Default [] → old callers unchanged.
  answer_image_refs: z.array(z.string()).default([]),
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
type SubmitBodyT = z.infer<typeof SubmitBody>;
type QuestionRow = typeof question.$inferSelect;

// F4 (PR #309 round-2, YUK-215) — the image-consuming judge routes set is now
// shared from `@/server/judge/route-resolve` (IMAGE_CONSUMING_JUDGE_ROUTES) so
// the photo-only gate cannot drift between this single-question flow and the
// paper-submit flow (F1).

// ============================================================================
// Phase 1 — validate: parse body, resolve review identity, load question row.
// ============================================================================

interface ValidatedSubmit {
  body: SubmitBodyT;
  now: Date;
  questionId: string;
  activityRef: ReturnType<typeof normalizeReviewSubmitActivityRef>['activity_ref'];
  q: QuestionRow;
}

async function validateSubmit(req: Request): Promise<ValidatedSubmit> {
  const raw = await req.json().catch(() => null);
  const parsed = SubmitBody.safeParse(raw);
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
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

  return { body, now, questionId, activityRef: identity.activity_ref, q };
}

// ============================================================================
// Phase 2 — judge: resolve judge result + final rating, all OUTSIDE the FSRS
// transaction (read-only; no events written).
// ============================================================================

interface JudgedSubmit {
  judgeResult: JudgeResultV2T | null;
  judgeRoute: string | null;
  judgeTelemetry:
    | Awaited<ReturnType<ReturnType<typeof createDefaultJudgeInvoker>['invoke']>>['telemetry']
    | null;
  suggestedRating: Rating | null;
  finalRating: Rating;
  adviceCauseCategory: Awaited<ReturnType<typeof resolveAdviceCauseForQuestion>>;
}

async function judgeSubmit({ body, questionId, q }: ValidatedSubmit): Promise<JudgedSubmit> {
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
  // YUK-215 (PR #309 round-1, F1) — a photo-only answer (no typed text but
  // handwriting-photo refs present) is a real, judgeable answer. The judge
  // gate keys on "has any answer" = text OR image, not text alone; otherwise a
  // photographed answer was frozen into the event yet never judged.
  const hasImageAnswer = body.answer_image_refs.length > 0;
  const hasAnswer = answerMd.length > 0 || hasImageAnswer;
  // F4 (PR #309 round-2) — a PHOTO-ONLY answer is judgeable ONLY by an
  // image-consuming route. When the resolved route reads text alone, the empty
  // `answerMd` would be scored as a wrong answer and pollute FSRS, so we route
  // such a submit to the no-judge path (recorded but not auto-rated).
  const photoOnly = answerMd.length === 0 && hasImageAnswer;

  // F3 (PR #309 round-4, YUK-215) — resolve the route the invoker WOULD dispatch
  // (same resolver, invoker.ts:95) BEFORE deciding whether to trust any judge
  // result, so the photo-only gate covers BOTH paths uniformly. Pre-fix the gate
  // only ran inside the server-invoke branch (judgeResult===null); a client that
  // supplied `judge_result_v2` for a photo-only answer on a text-only route
  // bypassed the gate entirely — its verdict was trusted and (with auto_rate)
  // written to FSRS, exactly the text-only-route pollution F4 set out to stop.
  // Resolving up front + ignoring the supplied result on the unsupported case
  // makes the supplied and invoke paths share one gate (same semantics as the
  // invoke path: auto_rate → 422, non-auto_rate → recorded unjudged).
  let judgeRoute: string | null = null;
  let photoOnlyUnsupported = false;
  // Resolve the subject profile ONCE (when there is any answer) and reuse it for
  // BOTH the route gate and the invoke below. Resolving it twice would consume a
  // test's `mockResolvedValueOnce` on the first call (letting the invoke fall
  // through to the real resolver) and is a needless second DB round-trip.
  const subjectProfile = hasAnswer
    ? await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids)
    : null;
  if (subjectProfile !== null) {
    const resolvedRoute = resolveQuestionJudgeRoute(q, subjectProfile);
    photoOnlyUnsupported = photoOnly && !IMAGE_CONSUMING_JUDGE_ROUTES.has(resolvedRoute);
    if (photoOnlyUnsupported) {
      // Surface the route for the 422 message; the supplied/invoke result is
      // discarded below so no client verdict can reach FSRS for this case.
      judgeRoute = resolvedRoute;
    }
  }

  // F3 — only trust a supplied result when the route can actually consume the
  // photo. A client-supplied verdict for a photo-only + text-only-route slot is
  // ignored (treated as no judge), routing to the same no-judge path as the
  // server-invoke branch instead of being trusted.
  const suppliedJudgeResult =
    hasAnswer && !photoOnlyUnsupported ? (body.judge_result_v2 ?? null) : null;
  let judgeResult: JudgeResultV2T | null = suppliedJudgeResult;
  if (suppliedJudgeResult !== null) {
    judgeRoute = suppliedJudgeResult.capability_ref.id;
  }
  let judgeTelemetry: JudgedSubmit['judgeTelemetry'] = null;
  if (judgeResult === null && !photoOnlyUnsupported && subjectProfile !== null) {
    const invoked = await createDefaultJudgeInvoker().invoke({
      db,
      question: q,
      answer_md: answerMd,
      // YUK-215 — pass handwriting-photo refs to the judge (invoker accepts
      // student_image_refs; invoker.ts:46). Optional → no-image submits and
      // client-supplied-judge submits are byte-for-byte unchanged.
      student_image_refs: body.answer_image_refs,
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
      // No suggested rating in auto_rate mode has three causes:
      //   1. No answer at all (neither text NOR image) — name both inputs.
      //   2. F4 (round-2) / F3 (round-4): a photo-only answer routed to a
      //      text-only judge — this question type cannot grade a pure-image
      //      answer, so ask for typed text (or manual rating). We must NOT score
      //      the empty text wrong. `photoOnlyUnsupported` is resolved up front
      //      (above) and now covers BOTH the server-invoke and client-supplied
      //      result paths (F3) — a supplied verdict for this case was discarded.
      //   3. The judge ran but returned coarse_outcome='unsupported'.
      let message: string;
      if (!hasAnswer) {
        message =
          'auto_rate requires an answer: response_md or answer_image_refs must be non-empty';
      } else if (photoOnlyUnsupported) {
        message = `judge route '${judgeRoute}' does not support photo-only answers; type your answer or rate manually`;
      } else {
        message = `judge route '${judgeRoute}' returned coarse_outcome='unsupported'; please rate manually`;
      }
      throw new ApiError('unsupported_judge_route', message, 422);
    }
    finalRating = suggestedRating;
  }

  return {
    judgeResult,
    judgeRoute,
    judgeTelemetry,
    suggestedRating,
    finalRating,
    adviceCauseCategory,
  };
}

// ============================================================================
// Phase 3 — persist: knowledge-set resolution + FSRS transaction (advisory
// locks → schedule → review event → state upsert) + post-txn refine trigger.
// ============================================================================

interface PersistedSubmit {
  eventId: string;
  outcome: 'success' | 'failure';
  fsrsSubjectKind: FsrsSubjectKind;
  fsrsSubjectIds: string[];
  finalResult: ReturnType<typeof scheduleReview>;
  finalFsrsStateAfter: ReturnType<typeof scheduleReview>['nextState'] & {
    last_review: Date | null;
  };
}

async function persistSubmit(
  { body, now, questionId, q }: ValidatedSubmit,
  {
    judgeResult,
    judgeRoute,
    judgeTelemetry,
    suggestedRating,
    finalRating,
    adviceCauseCategory,
  }: JudgedSubmit,
): Promise<PersistedSubmit> {
  // Codex / CodeRabbit (PR #295) — `referenced_knowledge_ids` used to drive
  // FSRS scheduling verbatim from the request body, letting a stale/superset
  // id steer scheduling onto knowledge points the reviewed question does not
  // tag (orphan projection rows, due-summary pollution). Orchestrator ruling:
  // do NOT 400 — instead schedule only on requested ∩ q.knowledge_ids; if that
  // intersection is empty but the question IS labeled, fall back to the
  // question's own labels. The event payload's `referenced_knowledge_ids`
  // keeps the ORIGINAL requested value (judge evidence may legitimately cite
  // knowledge beyond the question's tags; that trail must not be narrowed).
  const questionKnowledgeIds = Array.from(
    new Set(q.knowledge_ids.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  const requestedKnowledgeIds = Array.from(
    new Set(body.referenced_knowledge_ids.map((id) => id.trim()).filter((id) => id.length > 0)),
  );
  // Event-payload value: original requested ids when present, else the
  // question's own labels (preserves the prior default for legacy callers).
  const referencedKnowledgeIds =
    requestedKnowledgeIds.length > 0 ? requestedKnowledgeIds : questionKnowledgeIds;
  // FSRS-scheduling set: requested ∩ question labels. Empty intersection with a
  // labeled question falls back to the question labels; no request at all also
  // falls back to the question labels.
  const requestedIntersection = requestedKnowledgeIds.filter((id) =>
    questionKnowledgeIds.includes(id),
  );
  const fsrsKnowledgeIds =
    requestedKnowledgeIds.length === 0
      ? questionKnowledgeIds
      : requestedIntersection.length > 0
        ? requestedIntersection
        : questionKnowledgeIds;
  const fsrsSubjectKind: FsrsSubjectKind = fsrsKnowledgeIds.length > 0 ? 'knowledge' : 'question';
  const fsrsSubjectIds = fsrsSubjectKind === 'knowledge' ? fsrsKnowledgeIds : [questionId];

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
  let primaryFsrsStateAfter: PersistedSubmit['finalFsrsStateAfter'];

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM question WHERE id = ${questionId} FOR UPDATE`);

    const fsrsUpdates: Array<{
      subject_kind: FsrsSubjectKind;
      subject_id: string;
      result: ReturnType<typeof scheduleReview>;
      stateAfter: PersistedSubmit['finalFsrsStateAfter'];
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
        // YUK-215 — freeze the handwriting-photo refs into the review event so
        // the judge's evidence is traceable (project evidence-trail discipline;
        // mirrors the paper attempt payload's `answer_image_refs`, paper-submit
        // :425). Always present (default []) for a uniform read shape.
        answer_image_refs: body.answer_image_refs,
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

  return { eventId, outcome, fsrsSubjectKind, fsrsSubjectIds, finalResult, finalFsrsStateAfter };
}

// ============================================================================
// Route — compose the three phases and shape the wire response.
// ============================================================================

export async function POST(req: Request): Promise<Response> {
  try {
    const validated = await validateSubmit(req);
    const judged = await judgeSubmit(validated);
    const persisted = await persistSubmit(validated, judged);
    const { body, now, questionId, activityRef } = validated;
    const { judgeResult, judgeRoute, judgeTelemetry, suggestedRating, finalRating } = judged;
    const { eventId, fsrsSubjectKind, fsrsSubjectIds, finalResult, finalFsrsStateAfter } =
      persisted;

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
        activity_ref: activityRef,
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
