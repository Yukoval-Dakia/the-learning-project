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

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import { enqueueMasteryNoteRefine } from '@/capabilities/notes/server/note-refine-triggers';
import { notesForKnowledge } from '@/capabilities/notes/server/notes-read';
import { newId } from '@/core/ids';
import { ActivityRef } from '@/core/schema/activity';
import { FsrsRating, JudgeKind as JudgeKindZ } from '@/core/schema/business';
import { JudgeResultV2, type JudgeResultV2T } from '@/core/schema/capability';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { writeEvent } from '@/server/events/queries';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { createDefaultJudgeInvoker } from '@/server/judge/invoker';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  resolveQuestionJudgeRoute,
} from '@/server/judge/route-resolve';
import { recordFamilyObservationForAttempt } from '@/server/mastery/personalized-difficulty';
import { recordDifficultyCalibrationLabel } from '@/server/mastery/recalibration';
import { getMasteryState, updateThetaForAttempt } from '@/server/mastery/state';
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
  // YUK-372 L2 — 被答 practice_stream_item.id（π_i 直 join 判别子）。流作答（PfSolo）传被答
  // slot id；散题/复习等非流作答省略 → undefined → recordDifficultyCalibrationLabel 内 skip
  // （红线 #2：无 slot id 不退回 (date, ref) 近似）。optional+nullable → 旧 client 不传 → 无 π_i
  // 标签，向后兼容。
  stream_item_id: z.string().min(1).nullable().optional(),
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
  /** M2 (YUK-316)：独立 judge 锚点 event id——流 UI 的「不服判」入口需要它。 */
  judgeEventId: string | null;
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
  // M2 (YUK-316)：判定锚点 event id（事务内条件写入，响应层回传给「不服判」）。
  let judgeEventId: string | null = null;
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

    // YUK-56 — Embed judge result on the review event's payload (the same
    // jsonb-payload-embed pattern shared by the judge-writing routes).
    // Extra keys are stored via jsonb; ReviewOnQuestion Zod schema strips
    // unknown keys on parse, but writeEvent inserts the raw input.payload.
    //
    // Why not a separate action='judge' event chained via caused_by?
    // JudgeOnEvent requires payload.cause (cause attribution is a downstream
    // 'attribution' agent's job; this route only writes the assessment
    // trail). Embedding keeps the judge event channel clean for cause-bearing
    // events.
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
    // M2 (YUK-316, D15) — 散题判分同时写独立 judge event（镜像 paper-submit 的
    // 形态：actor=agent、subject=本次 review event、cause 为 attribution 占位）。
    // 这把散题判定纳入统一 judge 事件链：申诉重判（rejudge job）写新 judge event
    // 即可经 newest-wins（D6）盖掉本判定。review event 内嵌的 payload.judge 保留
    // ——既有读路径不变，这里只是补出可 supersede 的判定锚点。
    // gate：锚点只在 judge_route 是合法 JudgeKind 时写——服务端 invoker 路径
    // 天然满足；supplied judge_result_v2 路径中，「advice 预览 → submit 复用」
    // 的两段式（流 UI 的散题数据流）回传的 capability_ref.id 就是真实 route，
    // 同样合法可立锚点；任意第三方 supplied id 不在 enum 内则跳过（直接写会
    // 炸 JudgeOnEvent 校验，且无权威性）。
    if (judgeResult !== null && judgeRoute !== null && JudgeKindZ.safeParse(judgeRoute).success) {
      judgeEventId = newId();
      await writeEvent(tx, {
        id: judgeEventId,
        session_id: body.session_id ?? null,
        actor_kind: 'agent',
        actor_ref: 'review_judge',
        action: 'judge',
        subject_kind: 'event',
        subject_id: eventId,
        outcome: 'success',
        payload: {
          cause: {
            primary_category: 'other',
            secondary_categories: [],
            analysis_md: '<review-submit, attribution deferred>',
            confidence: judgeResult.confidence,
          },
          referenced_knowledge_ids: referencedKnowledgeIds,
          profile_version: judgeResult.capability_ref.version,
          capability_ref: judgeResult.capability_ref,
          judge_route: judgeRoute,
          coarse_outcome: judgeResult.coarse_outcome,
          ...(judgeResult.score != null ? { score: judgeResult.score } : {}),
          feedback_md: judgeResult.feedback_md,
          attribution_pending: true,
        },
        caused_by_event_id: eventId,
        task_run_id: null,
        cost_micro_usd: null,
        created_at: now,
      });
    }
    for (const update of fsrsUpdates) {
      await upsertFsrsState(tx, {
        subject_kind: update.subject_kind,
        subject_id: update.subject_id,
        state: update.stateAfter,
        due_at: update.result.dueAt,
        last_review_event_id: eventId,
      });
    }
    // YUK-361 finding #3 修复 — 在 updateThetaForAttempt **之前**捕获 primary knowledge
    // 的 PRE-attempt θ̂（作答当下的能力估计）。家族残差必须对着作答前的 θ̂ 算（mirror
    // state.ts precision 更新里 thetaBefore=s.theta 的纪律）；下面的 updateThetaForAttempt
    // 会把 mastery_state.theta_hat 移到 POSTERIOR，故必须先读。冷启（无 row）→ 0，与
    // updateThetaForAttempt 内部的冷启基（θ=0）一致。primary = q.knowledge_ids[0]（与
    // 家族键 + distinct 计数同源）。
    const primaryKnowledgeId = q.knowledge_ids[0];
    const thetaBefore = primaryKnowledgeId
      ? ((await getMasteryState(tx, primaryKnowledgeId))?.theta_hat ?? 0)
      : 0;

    // B1-W1 (ADR-0035) — θ̂ 在线更新（p(L) 诊断维，与上面 FSRS R 轴正交，三轴正交
    // 红线）。同 tx。并发串行化由 updateThetaForAttempt 内部对每个 KC 自取
    // `fsrs:knowledge:<id>` advisory lock 保证（review SF-2）——不依赖此处 FSRS 锁
    // 的覆盖范围（FSRS 锁只覆盖 fsrsSubjectIds = requested∩labels 子集，θ̂ 用全集
    // q.knowledge_ids，差集 KC 靠模块自锁兜住）。outcome 复用上面的 success/failure
    // 派生（review 路径 finalRating 二分，无 partial）。写独立 mastery_state 表，
    // 不碰 event/learning_record count——hermetic 不破。
    await updateThetaForAttempt(tx, {
      knowledgeIds: q.knowledge_ids,
      questionId,
      outcome: outcome === 'success' ? 1 : 0,
      difficulty: q.difficulty,
      attemptEventId: eventId,
      now,
      // A1 (YUK-433) — thread the solo review latency (ms) into the SRT credit path.
      // SRT is now LIVE (SRT_ENABLED=true, P1 go-live YUK-361): when latency_ms is
      // present, fast-correct moves θ̂ more than slow-correct (continuous srtOutcome).
      // body.latency_ms is number|null|undefined; undefined coerces to undefined →
      // binary fallback (paper path passes nothing; solo attempts lacking RT → binary).
      responseTimeMs: body.latency_ms ?? undefined,
      // YUK-372 L3 — enable family b_delta composition (NO-OP until the family gate passes).
      kind: q.kind,
      source: q.source,
      // Codex review F2 — 显式传 question 规范 primary（与 family 写/读两侧同键）。review 路径
      // knowledgeIds 本就是 q.knowledge_ids，故 [0] 已等于 primaryKnowledgeId；显式传保契约一致。
      familyPrimaryKnowledgeId: primaryKnowledgeId,
    });

    // YUK-361 Phase 5 — 家族级 b_personalized 观测（慢尺度，与上面 θ̂ 快尺度正交）。
    // 同 tx（计数与作答一致），但 best-effort：绝不让它 fail 上面的 θ̂/FSRS/event 主路径。
    // 门 (a) 在内部判：judgeRoute 非客观路由（exact/keyword 之外，含 null=纯手评）→
    // 内部早返不触 DB。primary knowledge = q.knowledge_ids[0]（canonical 家族基，与
    // distinct 计数同源——见 personalized-difficulty.ts finding #3b 文档）。
    //
    // finding #2 修复 — **只在 outcome 真正来自客观 auto-judge 时**才折进家族校准，即
    // body.auto_rate=true（judge 的 suggested rating 实际驱动了 finalRating，见上方
    // judgeSubmit）。若 auto_rate=false：即便 client 传了客观 judge_route 的预览
    // judge_result_v2，finalRating 仍来自**用户手动 body.rating**（advisor 信息性、永不
    // 自动 commit，见 YUK-98 driver §1.1），把手动评分当客观 b 真值校准是错的（手评带
    // 用户主观，污染 b 通道）。故 gate 在 body.auto_rate，而非「存在客观 judge_route 串」。
    //
    // finding #3 修复 — 传 thetaBefore（上面捕获的 PRE-attempt θ̂），不让 hook 读已被本次
    // 作答移动过的 POSTERIOR mastery_state.theta_hat。
    //
    // finding #4a 修复 — 用 SAVEPOINT（嵌套 tx）隔离家族写：family 语句直接跑在外层 tx
    // 上时，任何 DB 级错误（advisory lock 序列化/死锁、statement timeout、并发首插的
    // 23505 unique-violation、malformed-jsonb cast）会毒化 PG tx（25P02），外层
    // db.transaction 随后整体 rollback + re-throw——θ̂/FSRS/event 全丢，JS try/catch
    // 捕到了也救不回（捕 JS 错 ≠ 解毒 PG tx）。tx.transaction(...) 经 drizzle 转成
    // SAVEPOINT，family 写失败只回滚 savepoint，主 attempt 写完整保留可 COMMIT。
    // 同 Phase 3 telemetry-in-tx bug 同类修复。
    if (body.auto_rate) {
      try {
        await tx.transaction(async (sp) => {
          await recordFamilyObservationForAttempt(sp, {
            primaryKnowledgeId,
            questionId,
            kind: q.kind,
            source: q.source,
            difficulty: q.difficulty,
            outcome: outcome === 'success' ? 1 : 0,
            judgeRoute,
            thetaBefore,
            now,
          });
        });
      } catch (err) {
        console.warn('recordFamilyObservationForAttempt (submit) failed (non-fatal):', err);
      }

      // YUK-361 Phase 6 (Task 11) — active-PPI 难度标签记录（与上面家族观测同纪律）。
      // 在**独立的** SAVEPOINT 内 best-effort：标签写失败只回滚本 savepoint，不连累上面
      // 的家族写、更不毒化主 attempt tx（θ̂/FSRS/event）。同 auto_rate 门（手评不当客观 b
      // 真值，§6）。hook 内部：非客观判分 / partial / 无真 π_i（softmax_mfi selected 观测）
      // → skip 不写。thetaBefore = PRE-attempt θ̂（同家族 hook，b_label 反推锚定它）。
      try {
        await tx.transaction(async (sp) => {
          await recordDifficultyCalibrationLabel(sp, {
            questionId,
            attemptEventId: eventId,
            difficulty: q.difficulty,
            outcome: outcome === 'success' ? 1 : 0,
            judgeRoute,
            thetaBefore,
            now,
            // YUK-372 L2 — 被答 slot id（无 → hook skip，红线 #2 不退回近似）。
            streamItemId: body.stream_item_id ?? null,
          });
        });
      } catch (err) {
        console.warn('recordDifficultyCalibrationLabel (submit) failed (non-fatal):', err);
      }
    }
  });
  // After the txn: primaryResult + primaryFsrsStateAfter were assigned inside; assert
  // non-null for TS narrowing (txn either commits and assigns, or throws).
  // biome-ignore lint/style/noNonNullAssertion: assigned inside the txn
  const finalResult = primaryResult!;
  // biome-ignore lint/style/noNonNullAssertion: assigned inside the txn
  const finalFsrsStateAfter = primaryFsrsStateAfter!;

  // M3 (YUK-317)：Living Note 流作答信号。旧形态只对带 source_ref 的笔记
  // 衍生题触发——流内普通题（manual/ingestion）作答是死线。新触发器按
  // question.knowledge_ids 派生 labeled notes（D6 后 error_rate 的替代信号源），
  // source_ref 直指来源笔记的旧线保留；triggers 层 1h debounce 防风暴。
  if (outcome === 'success') {
    const targetArtifactIds = new Set<string>();
    if (q.source_ref) targetArtifactIds.add(q.source_ref);
    for (const kid of q.knowledge_ids) {
      const labeled = await notesForKnowledge(db, kid);
      for (const note of labeled) targetArtifactIds.add(note.id);
    }
    for (const artifactId of targetArtifactIds) {
      await enqueueMasteryNoteRefine({
        db,
        artifactId,
        questionId,
        triggerEventId: eventId,
      });
    }
  }

  return {
    eventId,
    judgeEventId,
    outcome,
    fsrsSubjectKind,
    fsrsSubjectIds,
    finalResult,
    finalFsrsStateAfter,
  };
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
            // M2 (YUK-316) — 申诉锚点 id（流 UI「不服判」直接对它发 appeal）。
            judge_event_id: persisted.judgeEventId,
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
