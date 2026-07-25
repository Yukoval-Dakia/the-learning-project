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
// caller explicitly requests `auto_rate`, run the judge and embed the result in
// the review event's `payload.judge` (mirrors embedded-check pattern). A supplied
// `judge_result_v2` may also be embedded without another call. When `auto_rate:
// true`, the suggested rating wins over body.rating. CC-1: this
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

import type { Provider } from '@/ai/registry';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import { enqueueMasteryNoteRefine } from '@/capabilities/notes/server/note-refine-triggers';
import { emitMasteryProgressSignal } from '@/capabilities/practice/server/mastery-progress-signal';
import { newId } from '@/core/ids';
import { JudgeKind as JudgeKindZ } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
// YUK-471 Wave 0 (ADR-0044 §3) — FSRS Card type for the per-subject snapshot `before`.
import type { JudgeExecutionProvenanceT } from '@/core/schema/event/known';
import { type Tx, db } from '@/db/client';
import { learning_session, mastery_state, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import {
  ApiError,
  canonicalResourceResponse,
  deprecatedRouteResponse,
  errorResponse,
} from '@/kernel/http';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  createDefaultJudgeInvoker,
  deterministicExecutionProvenance,
  isModelBackedJudgeRoute,
  judgeProvenanceSigningSecret,
  modelExecutionProvenance,
  resolveInvokedExecutionProvenance,
  resolveQuestionJudgeRoute,
  semanticInput,
  sha256Canonical,
  suppliedUnverifiedExecutionProvenance,
  taskInputHash,
  verifyJudgePreviewProvenanceToken,
} from '@/kernel/judge';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import { writeJobEvent } from '@/server/events/writer';
import { type FsrsSubjectKind, getFsrsState, upsertFsrsState } from '@/server/fsrs/state';
import { checkRateLimit, refundRateLimit } from '@/server/http/rate-limit';
import { recordFamilyObservationForAttempt } from '@/server/mastery/personalized-difficulty';
import {
  PREREQ_RISK_EMIT_ENABLED,
  emitPrereqRiskSignal,
} from '@/server/mastery/prereq-propagation';
import { recordDifficultyCalibrationLabel } from '@/server/mastery/recalibration';
import {
  ABILITY_GLOBAL_SUBJECT_KIND,
  getMasteryState,
  resolveAbilityGlobalSubjectIds,
  updateThetaForAttempt,
} from '@/server/mastery/state';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import type { SubjectProfile } from '@/subjects/profile';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { normalizeReviewSubmitActivityRef } from '../server/activity-ref';
import { writeAttemptSnapshotBrackets } from '../server/attempt-snapshot';
import { resolveAdviceCauseForQuestion } from '../server/cause-context';
import { activeEffectiveTruth } from '../server/effective-truth';
import { enqueueWrongStreakNudge } from '../server/enqueue-wrong-streak-nudge';
import { initialFsrsState, scheduleReview } from '../server/fsrs';
import { judgeDurableEnabled } from '../server/judge-durable-config';
import { ratingFromCoarseOutcome } from '../server/judge-rating';
import {
  type JudgeRunEnqueueDeps,
  admitJudgeRun,
  enqueueJudgeRun,
  hasNewerAttemptEvidence,
  judgeRunJobId,
  recordJudgePendingAttempt,
} from '../server/judge-run-dispatch';
import { freezeQuestionForJudge } from '../server/judge-run-payload';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '../server/judge-run-status';
import { collectMasteryRefineTargets } from '../server/note-refine-targets';
import { judgeResultToRatingAdvice } from '../server/rating-advisor';
import { type CreateAttemptBody, CreateAttemptBodySchema } from './contracts';

type Rating = CreateAttemptBody['rating'];
type SubmitBodyT = CreateAttemptBody;
type QuestionRow = typeof question.$inferSelect;

// F4 (PR #309 round-2, YUK-215) — the image-consuming judge routes set is now
// shared via the `@/kernel/judge` facade (IMAGE_CONSUMING_JUDGE_ROUTES) so
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
  const parsed = CreateAttemptBodySchema.safeParse(raw);
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
  executionProvenance: JudgeExecutionProvenanceT | null;
  suggestedRating: Rating | null;
  finalRating: Rating;
  adviceCauseCategory: Awaited<ReturnType<typeof resolveAdviceCauseForQuestion>>;
}

// YUK-589 (J2, High-sec) — resolve execution provenance for a CLIENT-SUPPLIED judge
// result on a model-backed route. advice.ts issues a signed provenance token for EVERY
// model-invoked route (its condition is route-agnostic — advice.ts:82-100), so token
// verification must cover every signed model route, not just 'semantic'. The anti-forgery
// gate differs by route because only the semantic path can cheaply reconstruct the model's
// task input at submit time:
//   - semantic: recompute input_hash from semanticInput(q, profile) and bind the token's
//     input_hash to THIS question+answer (anti-replay against a different question).
//   - steps / multimodal_direct / unit_dimension: those runners build their task input
//     INSIDE the runner (image plumbing, structured narrowing), so submit cannot cheaply
//     replicate the input shape. Instead the gate is (a) token authenticity + binding of
//     task_run_id / subject profile / route / result_digest, plus (b) modelExecutionProvenance
//     re-querying the ai_task_runs row and corroborating the PERSISTED prompt_fingerprint +
//     result_digest against the signed claim — that DB corroboration (the question is embedded
//     in the persisted prompt_fingerprint) plus the result_digest binding IS the anti-forgery
//     gate for those routes. `result_digest === sha256Canonical(suppliedJudgeResult)` prevents
//     binding a real run to a result the model never produced.
// Any absent token or failed check → supplied_unverified (fail-closed). execution_provenance
// is an AUDIT STAMP on the attempt event, not a gate on trusting the verdict.
async function resolveSuppliedModelExecutionProvenance(params: {
  judgeRoute: string;
  suppliedJudgeResult: JudgeResultV2T;
  subjectProfile: SubjectProfile;
  body: SubmitBodyT;
  answerMd: string;
  q: QuestionRow;
}): Promise<JudgeExecutionProvenanceT> {
  const { judgeRoute, suppliedJudgeResult, subjectProfile, body, answerMd, q } = params;
  const signingSecret = judgeProvenanceSigningSecret();
  const claims =
    body.judge_provenance_token && signingSecret
      ? verifyJudgePreviewProvenanceToken(body.judge_provenance_token, signingSecret)
      : null;
  if (claims === null) return suppliedUnverifiedExecutionProvenance(judgeRoute);

  // Bindings shared by every signed model route.
  const commonMatch =
    claims.task_run_id === body.judge_task_run_id &&
    claims.subject_profile_id === subjectProfile.id &&
    claims.subject_profile_version === subjectProfile.version &&
    claims.judge_route === judgeRoute &&
    claims.result_digest === sha256Canonical(suppliedJudgeResult);
  // Semantic additionally re-derives input_hash from the current question+answer;
  // other routes defer to the DB prompt_fingerprint corroboration below.
  const routeMatch =
    judgeRoute === 'semantic'
      ? claims.task_kind === 'SemanticJudgeTask' &&
        claims.input_hash ===
          taskInputHash({
            question: semanticInput(q, subjectProfile),
            answer: { content: answerMd },
          })
      : true;
  if (!commonMatch || !routeMatch) return suppliedUnverifiedExecutionProvenance(judgeRoute);

  return modelExecutionProvenance(
    db,
    {
      task_kind: claims.task_kind,
      task_run_id: claims.task_run_id,
      input_hash: claims.input_hash,
      prompt_fingerprint: claims.prompt_fingerprint,
      prompt_template_revision: claims.prompt_template_revision,
      // YUK-589 — corroborate the exact result the run persisted, not just a
      // matching id/kind/input. commonMatch already proved this digest equals
      // sha256Canonical(suppliedJudgeResult).
      result_digest: claims.result_digest,
    },
    'supplied_verified',
  );
}

// YUK-594 (durable judge main path, W2) — durable judge_run handler reuses judgeSubmit
// as the shared judge-resolution head. These opts are set ONLY by that worker path
// (the sync HTTP route calls judgeSubmit() with no opts → byte-identical):
//   - `subjectProfile`: the D5-frozen profile (resolved at enqueue, reflecting the
//     learner's answer-time profile). Injected so the worker does NOT re-resolve
//     (which would pick up a profile edited between enqueue and pickup).
//   - `skipRateLimit`: the worker is not bound by the sync HTTP request budget
//     (that gate exists to cap in-request paid AI calls; the durable lane's cap is
//     the pg-boss retry budget).
//   - `durable`: forces the invoker's in-process transient retry OFF (D7) and, on the
//     fallback redelivery, crosses to the fallback provider lane (D9).
export interface JudgeSubmitOptions {
  subjectProfile?: SubjectProfile;
  skipRateLimit?: boolean;
  durable?: { providerOverride?: Provider };
}

/**
 * #7 — single predicate for "would this submit spend a synchronous server-side judge
 * call?", shared by judgeSubmit's invoke gate AND resolveDurableDivert's divert
 * decision so the condition can't drift between them. True iff: auto_rate requested,
 * no client-supplied verdict, the resolved route is NOT photo-only-unsupported, and a
 * subject profile resolved. (hasAnswer is implied — a photo-only answer routes to
 * photoOnlyUnsupported, and a no-answer submit resolves no profile / fails the gate.)
 */
export function wouldServerInvokeJudge(p: {
  autoRate: boolean;
  hasSuppliedResult: boolean;
  photoOnlyUnsupported: boolean;
  hasProfile: boolean;
}): boolean {
  return p.autoRate && !p.hasSuppliedResult && !p.photoOnlyUnsupported && p.hasProfile;
}

export async function judgeSubmit(
  { body, questionId, q }: ValidatedSubmit,
  opts: JudgeSubmitOptions = {},
): Promise<JudgedSubmit> {
  // YUK-56/YUK-98 — Resolve the judge result BEFORE the FSRS transaction.
  // If the UI already generated advice, reuse its `judge_result_v2` so final
  // submit doesn't call the judge twice. Otherwise, only explicit auto_rate
  // requests run the read-only judge outside the txn (no events written). We
  // need the result up-front to:
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
  // YUK-594 (D5) — the durable worker injects the frozen answer-time profile; the
  // sync path resolves it fresh (opts absent → byte-identical).
  const subjectProfile = hasAnswer
    ? (opts.subjectProfile ?? (await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids)))
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
  let executionProvenance: JudgeExecutionProvenanceT | null = null;
  if (suppliedJudgeResult !== null && judgeRoute !== null) {
    // A supplied result on a MODEL-backed route (semantic/steps/multimodal_direct/
    // unit_dimension) is verified against its signed provenance token — advice.ts signs
    // every model route, so verification is no longer semantic-only (J2). A genuinely
    // deterministic route (exact/keyword) needs no token: its verdict is a local string
    // compare, so it is stamped `deterministic`.
    if (isModelBackedJudgeRoute(judgeRoute)) {
      // YUK-589 (K1c) — a supplied MODEL result must NEVER fall to `deterministic`.
      // Gate on the route class FIRST; if the profile is somehow unresolved (no
      // profile for the question's knowledge), a model result cannot be verified,
      // so fail closed to `supplied_unverified` — never trust it as a no-model
      // local compare. When the profile is present, run the token verification.
      executionProvenance =
        subjectProfile !== null
          ? await resolveSuppliedModelExecutionProvenance({
              judgeRoute,
              suppliedJudgeResult,
              subjectProfile,
              body,
              answerMd,
              q,
            })
          : suppliedUnverifiedExecutionProvenance(judgeRoute);
    } else {
      executionProvenance = deterministicExecutionProvenance(judgeRoute);
    }
  }
  if (
    wouldServerInvokeJudge({
      autoRate: body.auto_rate,
      hasSuppliedResult: judgeResult !== null,
      photoOnlyUnsupported,
      hasProfile: subjectProfile !== null,
    })
  ) {
    // wouldServerInvokeJudge returned true ⇒ hasProfile was true ⇒ subjectProfile is
    // non-null. TS can't see through the predicate, so narrow explicitly (the throw is
    // unreachable — it documents the invariant the predicate guarantees).
    if (subjectProfile === null) {
      throw new ApiError(
        'corrupt_state',
        'server-invoke gate reached with no subject profile',
        500,
      );
    }
    // YUK-694 — only explicit auto-rate requests may spend a server-side judge
    // call, and those calls share the process-wide paid-AI request budget.
    // YUK-594 — the durable worker path skips this gate (it is not bound by the
    // sync HTTP request budget; the durable cap is the pg-boss retry budget).
    if (!opts.skipRateLimit) checkRateLimit();
    const invoked = await createDefaultJudgeInvoker().invoke({
      db,
      question: q,
      answer_md: answerMd,
      // YUK-215 — pass handwriting-photo refs to the judge (invoker accepts
      // student_image_refs; invoker.ts:46). Optional → no-image submits and
      // client-supplied-judge submits are byte-for-byte unchanged.
      student_image_refs: body.answer_image_refs,
      subjectProfile,
      // YUK-212 + YUK-484(B) — narrow the judge to the submitted sub. null for
      // atomic single-question submits → no-op (whole-row). Narrows text +
      // structured before routing.
      part_ref: body.part_ref ?? null,
      // YUK-594 (D7/D9) — durable-run scoped runner overrides (worker only; the sync
      // path passes no opts → `durable` absent → invoker byte-identical).
      ...(opts.durable ? { durable: opts.durable } : {}),
    });
    judgeResult = invoked.result;
    judgeRoute = invoked.route;
    judgeTelemetry = invoked.telemetry;
    // YUK-589 (K1) — stamp off the honest model-attempt signal, NOT route
    // membership. execution present → `invoked`; model attempted but no execution
    // (LLM call/metadata/persist failed) → `historical_unknown`; no model
    // attempted (exact/keyword, or an accelerator-resolved unit_dimension slot) →
    // `deterministic`. Shared with paper-submit / rejudge via one resolver.
    executionProvenance = await resolveInvokedExecutionProvenance(db, invoked);
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
    executionProvenance,
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
  /**
   * W5 — true when the out-of-order guard fired: the attempt's evidence (review + judge
   * event) was recorded, but EVERY derived write was skipped because newer evidence for this
   * material already exists. Surfaced so the durable handler can stamp it on the terminal
   * job_event (observability: a verdict landed, but the schedule intentionally did not move).
   * Always false unless `enforceAttemptOrdering` was requested.
   */
  lateArrival: boolean;
}

// YUK-594 (W2) — the durable judge_run worker reuses persistSubmit as the shared
// backfill body (review event + judge event + FSRS/θ̂/snapshot/family/calibration in
// one tx + post-commit signals), passing `attemptEventId` = the reserved run_id so
// the written attempt event id equals the run handle (the judge_run idempotency guard
// keys on that event's existence). Omitted on the sync path → `newId()` → byte-identical.
export interface PersistSubmitOptions {
  attemptEventId?: string;
  /**
   * W5 — enable the out-of-order (late-arrival) guard. Set ONLY by the durable worker.
   *
   * The hazard exists exactly where a verdict is DEFERRED: the durable lane can commit an
   * older attempt after a newer one already advanced the same material. Two concurrent
   * SYNCHRONOUS submits cannot produce it — each carries `now = request time` and they
   * serialize on the learning-state lock, so the later writer always has the later stamp.
   * Gating the check here keeps the sync path byte-identical AND free of the two extra
   * reads the detection costs.
   */
  enforceAttemptOrdering?: boolean;
}

/**
 * W5 #Tuey8 / YUK-777 B1+B2 — has any material this attempt would WRITE already absorbed a
 * newer attempt?
 *
 * The check has TWO independent halves, and it needs both because they fail in opposite ways.
 *
 * **(a) The evidence water mark (YUK-777 B2, codex #Tu1cY) — the primary.** Every durable
 * attempt writes an immutable `experimental:judge_pending_attempt` row at submit time,
 * unconditionally. Asking "does a NEWER such row overlap my material?" is therefore answerable
 * from evidence that exists whether or not any derived write happened. That is precisely what
 * the projection half cannot do: a run judged late skips EVERY derived write, so it leaves no
 * trace in the projections, and the next older attempt reads them, sees nothing, and walks the
 * material backwards. One skip used to open the gate for every older attempt behind it.
 *
 * **(b) The projection water mark — retained, not replaced.** It is what covers writers that
 * leave no pending-attempt row: a MANUAL-rating submit is never diverted (it makes no judge
 * call) and advances FSRS synchronously, so only the projections record it. Three sources,
 * one per write target:
 *   - `material_fsrs_state.state.last_review` — the FSRS axis (jsonb ⇒ needs date coercion).
 *   - `mastery_state(subject_kind='knowledge').last_outcome_at` — the per-KC θ̂ axis.
 *   - `mastery_state(subject_kind='ability_global').last_outcome_at` — the per-DOMAIN θ̂ axis
 *     (YUK-777 B1, codex #TuxJJ). This one is a SHARED row: sibling KCs under one domain
 *     collide there while sharing no knowledge id, so a KC-keyed check structurally cannot see
 *     it. Subject ids come from `resolveAbilityGlobalSubjectIds`, which walks domains with the
 *     same resolver + same orphan-degrade the write path uses, so read and write agree.
 *
 * Enumerating write targets is what kept producing same-family holes (three rounds of them),
 * which is why (a) is the anchor and (b) is the belt: (a) does not depend on knowing the write
 * set, only on the material the attempt covers.
 */
async function detectLateArrival(
  tx: Tx,
  input: {
    now: Date;
    fsrsSubjectKind: FsrsSubjectKind;
    fsrsSubjectIds: string[];
    knowledgeIds: string[];
    questionId: string;
    /** This attempt's own run handle — its own pending row must not indict it. */
    runId: string;
  },
): Promise<boolean> {
  const { now, fsrsSubjectKind, fsrsSubjectIds, knowledgeIds, questionId, runId } = input;
  const nowMs = now.getTime();

  // (a) Evidence first — it is both the cheapest to reason about and the only half that
  // survives a preceding skip.
  if (await hasNewerAttemptEvidence(tx, { now, questionId, knowledgeIds, excludeRunId: runId })) {
    return true;
  }

  if (fsrsSubjectIds.length > 0) {
    const rows = await tx
      .select({ state: material_fsrs_state.state })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, fsrsSubjectKind),
          inArray(material_fsrs_state.subject_id, fsrsSubjectIds),
        ),
      );
    for (const row of rows) {
      const lastReview = coerceJsonbDate(row.state?.last_review ?? null);
      if (lastReview !== null && lastReview.getTime() > nowMs) return true;
    }
  }

  // θ̂ is written for the question's FULL label set, independent of the FSRS subset.
  const thetaSubjectIds = Array.from(new Set(knowledgeIds)).filter((id) => id.length > 0);
  if (thetaSubjectIds.length > 0) {
    const rows = await tx
      .select({ lastOutcomeAt: mastery_state.last_outcome_at })
      .from(mastery_state)
      // W5 #TusVG — `subject_kind` is HALF the key. `mastery_state` is unique on
      // (subject_kind, subject_id) and hosts hierarchical-Elo `ability_global` rows keyed by a
      // DOMAIN id in a separate partition, so filtering on `subject_id` alone can pick up a
      // non-knowledge row's `last_outcome_at`. A hit there would misread a perfectly ordered
      // backfill as late and silently skip EVERY derived write. Same filter the write side
      // uses (`updateThetaForAttempt`, mastery/state.ts:226) so the read and write agree.
      .where(
        and(
          eq(mastery_state.subject_kind, 'knowledge'),
          inArray(mastery_state.subject_id, thetaSubjectIds),
        ),
      );
    for (const row of rows) {
      const lastOutcomeAt = coerceJsonbDate(row.lastOutcomeAt);
      if (lastOutcomeAt !== null && lastOutcomeAt.getTime() > nowMs) return true;
    }
  }

  // YUK-777 B1 — the SHARED per-domain θ_global rows. Empty (and unread) when
  // HIERARCHICAL_ELO_ENABLED is off, because then no global row is written either.
  const abilityGlobalIds = await resolveAbilityGlobalSubjectIds(tx, knowledgeIds);
  if (abilityGlobalIds.length > 0) {
    const rows = await tx
      .select({ lastOutcomeAt: mastery_state.last_outcome_at })
      .from(mastery_state)
      .where(
        and(
          eq(mastery_state.subject_kind, ABILITY_GLOBAL_SUBJECT_KIND),
          inArray(mastery_state.subject_id, abilityGlobalIds),
        ),
      );
    for (const row of rows) {
      const lastOutcomeAt = coerceJsonbDate(row.lastOutcomeAt);
      if (lastOutcomeAt !== null && lastOutcomeAt.getTime() > nowMs) return true;
    }
  }

  return false;
}

export async function persistSubmit(
  { body, now, questionId, q }: ValidatedSubmit,
  {
    judgeResult,
    judgeRoute,
    judgeTelemetry,
    executionProvenance,
    suggestedRating,
    finalRating,
    adviceCauseCategory,
  }: JudgedSubmit,
  opts: PersistSubmitOptions = {},
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
  // YUK-594 (W2) — durable worker injects the reserved run_id as the attempt event id
  // (run handle ≡ attempt event id, submit-face contract); sync path mints a fresh id.
  const eventId = opts.attemptEventId ?? newId();
  // M2 (YUK-316)：判定锚点 event id（事务内条件写入，响应层回传给「不服判」）。
  let judgeEventId: string | null = null;
  let primaryResult: ReturnType<typeof scheduleReview>;
  let primaryFsrsStateAfter: PersistedSubmit['finalFsrsStateAfter'];
  // W5 — hoisted out of the tx so the POST-COMMIT signals can honour it too (#TuezA).
  let lateArrival = false;

  await db.transaction(async (tx) => {
    // YUK-497 — global learning-state write lock FIRST (before the question row lock and the
    // per-subject fsrs:* locks below). Every material_fsrs_state / mastery_state writer and the
    // cascade revert acquire this same lock at tx entry, so the submit {b}→{a,b} vs revert
    // {a,b} lock-order inversion and absent-row check-then-insert races cannot interleave.
    await acquireLearningStateWriteLock(tx);
    await tx.execute(sql`SELECT id FROM question WHERE id = ${questionId} FOR UPDATE`);

    const fsrsUpdates: Array<{
      subject_kind: FsrsSubjectKind;
      subject_id: string;
      result: ReturnType<typeof scheduleReview>;
      stateAfter: PersistedSubmit['finalFsrsStateAfter'];
      // YUK-471 Wave 0 (ADR-0044 §3) — the PRE-attempt FSRS Card per subject, retained
      // for the state_snapshot append. `prevStateRow` is loop-local below; capturing
      // `before` per entry here keeps the FULL multi-subject snapshot (without this only
      // the primary's before would survive the loop → partial revert).
      before: FsrsStateSchemaT | null;
    }> = [];

    // ── W4 #TtWiA / W5 #Tuey8 — out-of-order (late) backfill guard ────────────────────
    // The durable lane decouples "when the learner answered" from "when the verdict lands".
    // An earlier run whose judge failed goes into 30s/60s redelivery while a LATER attempt on
    // the same material succeeds first; the older run then commits with an EARLIER `now` and
    // writes on top of the newer state. The tx lock serializes writes but cannot restore time
    // order, so last_review / due / θ̂ / snapshots all get walked backwards.
    //
    // **ONE SWITCH, not per-item triage** (coordinator ruling, W5). The first cut tried to
    // decide per derived write which ones were safe to keep; that produced two rounds of
    // same-family holes (a detection domain narrower than the write domain, then a
    // post-commit signal that read the newer attempt's Δθ̂). The surface is now binary:
    //
    //   late ⇒ write ONLY the immutable evidence (review event + judge event).
    //          EVERY derived write is skipped — FSRS, θ̂, snapshot brackets, family
    //          observation, calibration label, and all post-commit signals.
    //
    // Rationale: derived state is a pure function of the evidence log, so anything skipped
    // here is recoverable by replaying/recomputing from the events that DID land, whereas a
    // backwards write corrupts state that later attempts build on. Recording the attempt is
    // non-negotiable (immutable evidence); everything else can wait for a correct recompute.
    //
    // Detection covers the UNION of every write domain — see detectLateArrival.
    lateArrival = opts.enforceAttemptOrdering
      ? await detectLateArrival(tx, {
          now,
          fsrsSubjectKind,
          fsrsSubjectIds,
          knowledgeIds: q.knowledge_ids,
          questionId,
          // The durable lane sets `attemptEventId` = run_id, so on this path the attempt
          // event id IS the run handle its own pending row points at.
          runId: eventId,
        })
      : false;
    if (lateArrival) {
      console.warn(
        '[submit] late-arriving attempt — recording the evidence ONLY; every derived write is skipped (newer evidence already exists for this material)',
        { eventId, questionId, submittedAt: now.toISOString() },
      );
    }

    for (const subjectId of [...fsrsSubjectIds].sort()) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`fsrs:${fsrsSubjectKind}:${subjectId}`}))`,
      );
    }

    for (const subjectId of fsrsSubjectIds) {
      let prevStateRow: Awaited<ReturnType<typeof getFsrsState>> = null;
      // YUK-471 W0 (augment review) — the snapshot `before` must reflect THIS subject's own
      // row existence (null = cold-start for the snapshot subject → revert DELETEs the row),
      // NOT the legacy question-card fallback below (which only seeds scheduling continuity).
      // Captured BEFORE the fallback overwrites prevStateRow.
      let snapshotFsrsBefore:
        | NonNullable<Awaited<ReturnType<typeof getFsrsState>>>['state']
        | null = null;
      let result: ReturnType<typeof scheduleReview>;
      try {
        prevStateRow = await getFsrsState(tx, fsrsSubjectKind, subjectId);
        snapshotFsrsBefore = prevStateRow?.state ?? null;
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
        // YUK-471 Wave 0 (ADR-0044 §3) — this subject's PRE-attempt Card for the snapshot.
        // `snapshotFsrsBefore` (captured pre-fallback) reflects the SNAPSHOT SUBJECT row's
        // own existence: null = cold-start (no prior row for THIS subject → revert DELETEs
        // it). The question-card fallback only seeds scheduleReview; it must NOT make
        // `before` non-null for a knowledge subject whose own row was absent (else revert
        // would UPSERT a row that did not exist pre-attempt — table-shape drift).
        before: snapshotFsrsBefore,
        // NOTE the explicit `new Date(...)`: `FsrsStateSchema.last_review` is typed `Date`
        // via `z.coerce.date()`, but this row comes straight out of jsonb, so at RUNTIME the
        // value is still the ISO string it was stored as — the static type lies here.
        // Normalize before anyone calls a Date method on it.
      });
    }
    const primaryUpdate = fsrsUpdates[0];
    primaryResult = primaryUpdate.result;
    primaryFsrsStateAfter = primaryUpdate.stateAfter;

    // ── Late-arrival: report the UNCHANGED schedule ───────────────────────────────────
    // `lateArrival` was decided BEFORE this loop (see the guard above the FSRS section).
    // Nothing derived gets written, so neither the event payload nor the HTTP response may
    // claim an advance. `due` needs the same jsonb coercion as `last_review` — `dueAt` is
    // consumed as a real Date by the sync response shaping (`finalResult.dueAt.getTime()`),
    // and a raw ISO string would throw there.
    if (lateArrival) {
      for (const update of fsrsUpdates) {
        if (update.before) {
          // Warm card: report the prior schedule verbatim — it is what a reader will find.
          update.result = {
            nextState: update.before,
            dueAt: coerceJsonbDate(update.before.due) ?? now,
          };
          update.stateAfter = update.before;
        } else {
          // W5 #TumMl — COLD card (no row existed). The earlier version `continue`d here,
          // which left the freshly COMPUTED schedule in place: the upsert is skipped for
          // every subject, so the event payload advertised a brand-new schedule that was
          // never persisted — a due date no reader could ever observe. A never-reviewed
          // card whose attempt wrote nothing is still New, so report the never-reviewed
          // baseline. (`fsrs_state_after` is required + non-nullable by ReviewOnQuestion,
          // so "report nothing" is not available; this is the honest value.)
          const initial = initialFsrsState(now);
          update.result = { nextState: initial.state, dueAt: initial.dueAt };
          update.stateAfter = { ...initial.state, last_review: initial.state.last_review ?? null };
        }
      }
      primaryResult = fsrsUpdates[0].result;
      primaryFsrsStateAfter = fsrsUpdates[0].stateAfter;
    }

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
              // YUK-777 D3 (#TuxJL) — `score_meaning` is what makes `score` interpretable
              // (steps / unit_dimension score on different semantics), and it was persisted
              // NOWHERE: not here, not on the judge event. The durable lane's crash-recovery
              // path (`reconstructDoneFromDomainEvents`) can only return what the domain log
              // holds, so it had to omit the field and hand clients a bare number. Written
              // alongside `score` — the only place where keeping them apart is impossible.
              score_meaning: judgeResult.score_meaning,
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
        // YUK-336 — preserve the already-validated stream slot id on the immutable
        // review event. This is the authoritative join key for StreamView verdicts;
        // non-stream callers omit it and historical events remain valid.
        ...(body.stream_item_id ? { stream_item_id: body.stream_item_id } : {}),
        // YUK-562 (process-data 最小采集) — 学生自述解题思路。Conditional spread 保持
        // 字段 ABSENT（非 null）当调用方未带过程文本 → 既有 review event byte-identical。
        // API 侧先行；UI 采集框（PfSolo）过 design pre-flight 后接线传入 body.reasoning_trace。
        ...(body.reasoning_trace?.trim() ? { reasoning_trace: body.reasoning_trace } : {}),
        // YUK-444 (A10 答题置信度自评) — 学生看判定前的主观把握（1-5）。Conditional spread
        // 保持字段 ABSENT 当调用方未带（跳过 / 客观题 auto-commit）→ 既有 review event
        // byte-identical。**observe-only**：只透传落 payload，不参与 rating / FSRS / θ̂ 任何
        // 判分链路（本文件对 review 的 fsrs / mastery 计算完全不读它）。
        ...(typeof body.self_confidence === 'number'
          ? { self_confidence: body.self_confidence }
          : {}),
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
          execution_provenance: executionProvenance ?? deterministicExecutionProvenance(judgeRoute),
          coarse_outcome: judgeResult.coarse_outcome,
          ...(judgeResult.score != null ? { score: judgeResult.score } : {}),
          feedback_md: judgeResult.feedback_md,
          attribution_pending: true,
          // YUK-212 + YUK-484(B) — per-sub verdict 落点. Conditional spread keeps
          // the key ABSENT (not null) for atomic submits → byte-identical parse.
          // Use body.part_ref (this route has no `partRef` local). Cut-1:
          // observability only — mastery stays per-KC (θ̂ below is one per-KC call).
          ...(body.part_ref ? { sub_ref: body.part_ref } : {}),
        },
        caused_by_event_id: eventId,
        task_run_id: executionProvenance?.task_run_id ?? null,
        cost_micro_usd: null,
        created_at: now,
      });
    }
    // W4 #TtWiA — a late arrival records the attempt but must not walk the schedule
    // backwards, so the FSRS upsert (and the θ̂ update below) are skipped entirely.
    if (!lateArrival) {
      for (const update of fsrsUpdates) {
        await upsertFsrsState(tx, {
          subject_kind: update.subject_kind,
          subject_id: update.subject_id,
          state: update.stateAfter,
          due_at: update.result.dueAt,
          last_review_event_id: eventId,
        });
      }
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
    // W4 #TtWiA — θ̂ is as order-sensitive as FSRS (a late attempt would move the posterior
    // backwards onto an estimate that already absorbed a newer observation), so the late
    // path skips it too and contributes no θ̂ snapshots.
    const thetaResult = lateArrival
      ? {
          theta_snapshots: [] as Awaited<
            ReturnType<typeof updateThetaForAttempt>
          >['theta_snapshots'],
        }
      : await updateThetaForAttempt(tx, {
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

    // YUK-561 S2 (revert-bracket §4.1 / O2 dual-sibling) — A-class snapshot append,
    // now as TWO independent sibling brackets (θ̂ + FSRS) so a judge-overturn can
    // revert the θ̂ transition ALONE. Replaces the pre-S2 single snapshot hung off the
    // attempt event `eventId` — which was structurally UNREVERTABLE (eventId has
    // caused_by=null → always a cascade root → classifyRow=irreversible; register F8).
    // The helper writes each segment iff it moved + upholds the C↔snapshot same-
    // condition write invariant. MUST be in the OUTER `tx`, NOT a SAVEPOINT — a HARD
    // invariant of the attempt (dies with it on rollback). Appended BEFORE the best-
    // effort family/calibration SAVEPOINTs below so a SAVEPOINT rollback never touches
    // it. `ingest_at:now` + deterministic ids (inside the helper) give the outbox
    // opt-out + retried-tx idempotency (§6.7).
    // W4 #TtWiA — a late arrival moved NOTHING, so it gets NO revert bracket. The helper's
    // "write each segment iff it moved" rule keys on the ARRAY being non-empty, not on
    // `before !== after`, so passing the unchanged updates through would mint a checkpoint +
    // snapshot describing a transition that never happened — reversible state for a no-op.
    if (!lateArrival) {
      await writeAttemptSnapshotBrackets(tx, {
        attemptEventId: eventId,
        sessionId: body.session_id ?? null,
        now,
        thetaSnapshots: thetaResult.theta_snapshots,
        fsrsSnapshots: fsrsUpdates.map((update) => ({
          subject_kind: update.subject_kind,
          subject_id: update.subject_id,
          before: update.before,
          after: update.stateAfter,
        })),
      });
    }

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
    // W5 — family observation + calibration label are DERIVED estimates (b_personalized /
    // difficulty labels) anchored on `thetaBefore`, which for a late arrival is a posterior
    // that already absorbed a newer attempt. Same switch as everything else derived.
    if (body.auto_rate && !lateArrival) {
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
  // ── W5 #TuezA — post-commit signals are derived writes too ────────────────────────────
  // `emitMasteryProgressSignal` reads `mastery_state` AFTER commit and reports its
  // `last_theta_delta` as "this attempt's Δθ̂", with caused_by pointing at THIS attempt. On a
  // late arrival we deliberately skipped `updateThetaForAttempt`, so that delta belongs to the
  // NEWER attempt — emitting it would manufacture mis-attributed experiment data (the exact
  // signal ADR-0040 exists to keep honest). The note-refine trigger hangs off the same
  // "mastery progressed" premise, and the wrong-streak nudge / prereq-risk producer are the
  // same class. One switch: a late attempt emits no derived signals at all.
  if (lateArrival) {
    console.warn(
      '[submit] late-arriving attempt — skipping post-commit derived signals (mastery-progress, note-refine, wrong-streak, prereq-risk)',
      { eventId, questionId },
    );
    return {
      eventId,
      judgeEventId,
      outcome,
      fsrsSubjectKind,
      fsrsSubjectIds,
      finalResult,
      finalFsrsStateAfter,
      lateArrival,
    };
  }

  if (outcome === 'success') {
    // ADR-0040 决定2 — p(L) delta 埋点（READ-only 旁路）。触发条件 outcome===success
    // **未变**（PHASE-DEFERRED：跨阈 gating 待 N 周埋点选出阈值后才上）。这里只 READ
    // mastery_state 刚落库的真实 Δθ̂/p(L) 并 EMIT `experimental:mastery_progress` 事件，
    // 让 owner 从真实 Δ 分布里挑阈值。红线（ADR-0035）：绝不写 mastery_state/item_calibration/
    // FSRS——helper 内部纯 SELECT + writeEvent，best-effort（emit fail 不连累 refine 触发）。
    // 在 attempt tx COMMIT 之后调（getMasteryState 读到 POSTERIOR row）。
    // OCR MINOR (~:722) — kept the await deliberately: after parallelizing the
    // helper (Promise.all reads + Promise.allSettled writes) this is bounded to
    // ~1 read + ~1 write round-trip, and the helper swallows all failures
    // internally (it never rejects), so awaiting it cannot fail/block the submit
    // path. Awaiting (vs fire-and-forget) keeps ordering deterministic and avoids
    // an unhandled-rejection risk on the shared pool — the cleaner choice here.
    await emitMasteryProgressSignal({
      db,
      knowledgeIds: q.knowledge_ids,
      questionId,
      attemptEventId: eventId,
      now,
    });

    const targetArtifactIds = await collectMasteryRefineTargets(db, q.source_ref, q.knowledge_ids);
    for (const artifactId of targetArtifactIds) {
      await enqueueMasteryNoteRefine({
        db,
        artifactId,
        questionId,
        triggerEventId: eventId,
      });
    }
  }

  await enqueueWrongStreakNudge(outcome, eventId);

  // YUK-455 inc-E — prereq 诊断「向后传播」producer (dark-ship). 答错 B → 沿 KG 的
  // prerequisite 边向上找 B 的 transitive 前置 A，EMIT `experimental:prereq_risk` 观测事件
  // 上调 A 的掌握风险（喂画像 / surmise relation 诊断向后半）。
  // GATE = PREREQ_RISK_EMIT_ENABLED（module const, 默认 false）&& outcome==='failure'：
  // flag-off 时 `&&` 短路、emit 永不调用 → event set BYTE-IDENTICAL（YUK-455 回归锚）。
  // post-commit / best-effort（helper 内部吞错，绝不连累已落库的 attempt）。红线（ADR-0035）：
  // 只 EMIT 独立 event 投影，绝不写 mastery_state.theta_hat/fail_count（A 从未被作答）。
  if (PREREQ_RISK_EMIT_ENABLED && outcome === 'failure') {
    await emitPrereqRiskSignal({
      db,
      failedKnowledgeIds: q.knowledge_ids,
      questionId,
      attemptEventId: eventId,
      now,
    });
  }

  return {
    eventId,
    judgeEventId,
    outcome,
    fsrsSubjectKind,
    fsrsSubjectIds,
    finalResult,
    finalFsrsStateAfter,
    lateArrival,
  };
}

// ============================================================================
// YUK-594 (durable judge main path, W2) — async-main divert for the submit face.
// ============================================================================

/**
 * W4 #TtWiA — coerce a timestamp read out of the `material_fsrs_state.state` jsonb blob to a
 * real Date.
 *
 * The column is jsonb, so `due` / `last_review` arrive as ISO STRINGS even though
 * `FsrsStateSchema` types them `Date` — its `z.coerce.date()` only applies where the schema is
 * actually parsed, which this read path does not do. The static type lies, so any code calling
 * a Date method on these values must coerce first.
 *
 * Returns null for absent or unparseable input. For the ordering comparison that matters: an
 * unusable timestamp must NOT be treated as "newer than this attempt", which would wrongly
 * suppress a legitimate FSRS advance.
 */
function coerceJsonbDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const asDate = value instanceof Date ? value : new Date(value);
  return Number.isNaN(asDate.getTime()) ? null : asDate;
}

interface DurableDivert {
  /** true ⇒ this submit's server-side judge call must run on the durable lane. */
  divert: boolean;
  /** the D5-frozen profile (resolved once here, reused as the enqueue payload). */
  subjectProfile: SubjectProfile | null;
}

/**
 * Decide whether this submit's judging should divert to the durable `judge_run`
 * lane (async-main) instead of the in-request synchronous invoke. The predicate
 * mirrors judgeSubmit's server-invoke condition EXACTLY (submit.ts:318): only a
 * submit that WOULD spend a synchronous server-side judge call diverts —
 *   auto_rate && no client-supplied verdict && has an answer && not photo-only on a
 *   text-only route && the subject profile resolves.
 * Every other submit (manual rating, client-supplied verdict, no-answer 422,
 * photo-only-unsupported 422) has NO in-request LLM call, so there is nothing to
 * move off the request window — it stays on the synchronous path unchanged.
 *
 * Cheap checks short-circuit BEFORE the profile DB read so a non-diverting submit
 * pays no extra round-trip. Only reached when JUDGE_DURABLE_ENABLED is on.
 *
 * W4 #TtWh_ — `/api/attempts` is a SHARED entry point, not the practice-solo face alone, so
 * "would spend a judge call" is necessary but NOT sufficient to divert. See
 * {@link sessionAdmitsDurableDivert}.
 */
export async function resolveDurableDivert(validated: ValidatedSubmit): Promise<DurableDivert> {
  const { body, q } = validated;
  if (!body.auto_rate) return { divert: false, subjectProfile: null };
  if (body.judge_result_v2) return { divert: false, subjectProfile: null };
  const answerMd = body.response_md?.trim() ?? '';
  const hasImageAnswer = body.answer_image_refs.length > 0;
  const hasAnswer = answerMd.length > 0 || hasImageAnswer;
  if (!hasAnswer) return { divert: false, subjectProfile: null };
  const subjectProfile = await resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids);
  if (subjectProfile === null) return { divert: false, subjectProfile: null };
  const route = resolveQuestionJudgeRoute(q, subjectProfile);
  const photoOnly = answerMd.length === 0 && hasImageAnswer;
  const photoOnlyUnsupported = photoOnly && !IMAGE_CONSUMING_JUDGE_ROUTES.has(route);
  // Shared predicate with judgeSubmit's invoke gate (#7) — photo-only-unsupported →
  // divert:false (its 422 is a route-resolution check, no LLM call) but still return
  // the resolved profile for the caller to reuse (#8).
  // W4 #TtZ8c — `!== undefined && !== null` (the repo bans loose `!=`) and now identical to
  // judgeSubmit's `judgeResult !== null` call site, so the two gates read the same.
  const wouldJudge = wouldServerInvokeJudge({
    autoRate: body.auto_rate,
    hasSuppliedResult: body.judge_result_v2 !== undefined && body.judge_result_v2 !== null,
    photoOnlyUnsupported,
    hasProfile: subjectProfile !== null,
  });
  if (!wouldJudge) return { divert: false, subjectProfile };
  // W2 scope is the PRACTICE submit face only; the session gate keeps every other caller on
  // this shared route synchronous until W3 gives it the async protocol.
  const divert = await sessionAdmitsDurableDivert(body.session_id ?? null);
  return { divert, subjectProfile };
}

/**
 * W4 #TtWh_ (codex P1) — may a submit from THIS session be answered with a 202-pending?
 *
 * `/api/attempts` is shared. The placement probe posts through it with `auto_rate:true`
 * (`onboarding/ui/placement-api.ts` submitProbeAnswer) and then — `ScreenPlacement.tsx:192-194`
 * — immediately calls `/question-selections` for the next item. `placement-next.ts` computes
 * the answered set from PERSISTED review/attempt events keyed by `session_id`, so under a 202
 * the current question is not yet in the exclusion set: answeredCount stalls, the termination
 * check keeps the old value, and the probe can re-serve the question it just answered. The
 * W2 divert was written for the practice face and this shared entry point was the leak.
 *
 * The gate is an ALLOWLIST, not a placement deny-list: any session type that is not explicitly
 * admitted stays synchronous. A future caller mounting on this route therefore cannot silently
 * inherit the async contract — it has to opt in here, which is the point at which someone has
 * to check that its client actually tolerates a pending verdict.
 *
 * A submit with NO session_id is ad-hoc solo practice (the practice face's own shape) → admitted.
 */
export async function sessionAdmitsDurableDivert(sessionId: string | null): Promise<boolean> {
  if (sessionId === null) return true;
  const rows = await db
    .select({ type: learning_session.type })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const type = rows[0]?.type ?? null;
  // Unknown session id → treat as NOT admitted. The synchronous path is always correct; it is
  // only slower, so an unresolvable session must fail closed.
  if (type === null) return false;
  return DURABLE_DIVERT_SESSION_TYPES.has(type);
}

/**
 * The session types whose clients are known to tolerate the 202-pending contract. W2 =
 * practice review only. W3 admits the remaining faces as each one's client learns to wait for
 * the backfill (design §4/§5, YUK-777).
 */
const DURABLE_DIVERT_SESSION_TYPES: ReadonlySet<string> = new Set(['review']);

/**
 * #8 — EXPLICIT marker for "this response is a durable-judge divert". `createAttemptResource`
 * used to key on the bare `status === 202`, which silently assumes every 202 this route can
 * ever produce is a pending-judge body with no `review_event`; the day another 202 appears
 * for an unrelated reason, that heuristic hands the client a raw body and skips the resource
 * wrapper. A named header is a discriminant that cannot be reached by accident.
 */
export const DURABLE_DIVERT_HEADER = 'x-durable-divert';
export const DURABLE_DIVERT_JUDGE = 'judge';

/** The 202-pending contract body returned when a submit diverts to the durable lane. */
export interface DurableJudgePendingResponse {
  run_id: string;
  /** discriminant clients branch on (vs a resolved `judge` verdict). */
  verdict: 'pending';
  backfill: {
    channel: 'sse';
    url: string;
    poll_url: string;
  };
}

/** Build the 202-pending response for `runId` (body + Location + the #8 divert header). */
function durablePendingResponse(runId: string): Response {
  const eventsUrl = `/api/jobs/${JUDGE_RUN_TABLE}/${encodeURIComponent(runId)}/events`;
  const pollUrl = `/api/jobs/${JUDGE_RUN_TABLE}/${encodeURIComponent(runId)}/status`;
  const responseBody: DurableJudgePendingResponse = {
    run_id: runId,
    verdict: 'pending',
    backfill: { channel: 'sse', url: eventsUrl, poll_url: pollUrl },
  };
  return Response.json(responseBody, {
    status: 202,
    headers: { Location: eventsUrl, [DURABLE_DIVERT_HEADER]: DURABLE_DIVERT_JUDGE },
  });
}

export interface EnqueueDurableJudgeDeps extends JudgeRunEnqueueDeps {
  now?: Date;
}

/**
 * Reserve a run_id, RECORD THE ANSWER, enqueue the `judge_run` job, record the queued marker,
 * and return the 202-pending contract.
 *
 * run_id ≡ the (worker-written) attempt/outcome event id — a submit-face contract
 * (NOT universal; W3 faces define their own anchor). It is ALSO the pg-boss job id
 * (`SendOptions.id`, the YUK-758 orchestrator idiom), which lets the poll route ask pg-boss
 * whether a marker-less run really exists.
 *
 * **Ordering (YUK-777 A2): checkRateLimit → pending-attempt EVENT → boss.send → queued marker
 * → 202.** W1/W2 sent first and wrote no domain evidence at all, which made the pg-boss
 * payload the only home of the learner's answer until a delivery succeeded: a run that
 * exhausted its retries into `judge_run_dlq`, or whose question was deleted before pickup,
 * lost the answer permanently (codex #Tu71c). Evidence-first inverts that — the answer is
 * committed to the permanent domain log BEFORE anything depends on the queue, so the queue is
 * only a delivery mechanism and every one of its failure modes is recoverable
 * (`judge_pending_reconcile`, design §3.6b).
 *
 * That reordering is also why a failed `boss.send` now still returns **202**. It is no longer
 * a lie: the answer is durably recorded and the sweeper will judge it. The alternative —
 * reporting a submission failure for an answer we have in fact accepted — pushes the learner
 * to answer again and manufactures the duplicate attempt we have no idempotency key to
 * collapse. The dispatch failure is loud in the logs, where it belongs.
 *
 * **Idempotency is NOT solved here.** A client HTTP retry after a lost 202 mints a second
 * run_id, which the worker's run_id-keyed guard cannot collapse → a second paid judge + a
 * second attempt. W4 #TtWiC removed the short-window answer-hash dedupe that briefly stood in
 * for a real key: without a stable per-request idempotency key it could not tell a retry from
 * a genuine re-answer, and PfSolo explicitly supports re-answering the same question, so it
 * swallowed real attempts (no new immutable attempt, no FSRS advance). Closing this needs a
 * client-supplied `Idempotency-Key` threaded onto the run — a HARD prerequisite before
 * `JUDGE_DURABLE_ENABLED` is flipped on (YUK-800).
 */
export async function enqueueDurableJudge(
  validated: ValidatedSubmit,
  subjectProfile: SubjectProfile,
  deps: EnqueueDurableJudgeDeps = {},
): Promise<Response> {
  // W5 #Tunns — the answer time is the one captured at request parse (`validateSubmit`),
  // NOT a fresh clock read here. Between those two points this path awaits profile
  // resolution, the session-type lookup and possibly a cold pg-boss start, so two concurrent
  // submits can reach this line in the opposite order they arrived — handing the EARLIER
  // answer the LATER `submitted_at`. That stamp is what the worker's late-arrival detection
  // and FSRS/θ̂ scheduling order by, so an inverted pair would skip the genuinely newer
  // attempt or apply the older one on top of it. `deps.now` still overrides for tests.
  const now = deps.now ?? validated.now;
  const runId = newId();
  const submitInput = {
    body: validated.body,
    question_id: validated.questionId,
    subject_profile: subjectProfile,
    // #2 (codex) — freeze the question state the learner ANSWERED into the payload.
    // Without it the worker re-reads a mutable row at pickup, so an edit to
    // prompt/reference/choices/knowledge/difficulty between the 202 and pickup judges
    // (and schedules) a different question than the one on screen.
    question_snapshot: freezeQuestionForJudge(validated.q),
    submitted_at: now.toISOString(),
  };

  // ── (0) ADMISSION, before anything durable ──────────────────────────────────────────
  // Order matters here specifically because step (1) is now durable. A 429 must leave NO
  // pending attempt behind: the reconcile sweeper judges recorded-but-unjudged answers, so a
  // refusal that still recorded the answer would come back minutes later as a deferral, and
  // every rate-limited submit would get its paid judge anyway. Charging first keeps "refused"
  // and "accepted" disjoint. The token is handed to `enqueueJudgeRun` below rather than
  // charged twice, and comes back on any failure before the job is durable.
  let rateLimitToken: number;
  try {
    rateLimitToken = admitJudgeRun(deps);
  } catch (err) {
    return errorResponse(err);
  }

  try {
    // ── (1) RECORD THE ANSWER (YUK-777 A2) ────────────────────────────────────────────
    // The first durable act, and the only one whose failure may reject the submit: if this
    // throws, the answer genuinely is not recorded anywhere and a 5xx is the truth. It
    // carries the SAME frozen input the job does, so a recovery re-enqueue reproduces this
    // dispatch exactly (D5 profile freeze + the question snapshot survive recovery).
    const pendingEventId = await recordJudgePendingAttempt(db, {
      runId,
      sessionId: validated.body.session_id ?? null,
      questionId: validated.questionId,
      // The question's OWN labels: the θ̂ write domain, a superset of the FSRS subset. The
      // late-arrival guard reads this as the material water mark.
      knowledgeIds: validated.q.knowledge_ids,
      submit: submitInput,
      submittedAt: now,
    });

    // ── (2) DISPATCH ──────────────────────────────────────────────────────────────────
    // Through the shared rate-limited face (server/judge-run-dispatch.ts) — the same one the
    // reconcile sweeper uses, so no producer of paid judge work exists without a budget gate.
    // `jobId: runId` pins the pg-boss job id to the run handle so the poll route can do a PK
    // lookup instead of guessing from marker presence.
    try {
      await enqueueJudgeRun({ run_id: runId, caller: 'submit', submit: submitInput }, deps, {
        // The DERIVED uuid, not the run handle — pg-boss job ids are uuid columns and our
        // handles are cuid2s. See `judgeRunJobId`.
        jobId: judgeRunJobId(runId),
        token: rateLimitToken,
      });
    } catch (enqueueErr) {
      // The answer is recorded; only its delivery failed. `judge_pending_reconcile` scans the
      // domain log and re-enqueues it, so this is a DELAY, not a loss — and reporting a
      // failure here would push the learner to re-answer and mint a duplicate attempt we
      // have no idempotency key to collapse (YUK-800). Return the pending contract and make
      // the dispatch failure loud server-side.
      console.error(
        '[submit] durable judge enqueue failed — the answer is recorded; the reconcile sweeper will re-enqueue it',
        { runId, pendingEventId },
        enqueueErr,
      );
      return durablePendingResponse(runId);
    }

    // ── (3) Advisory queued marker ────────────────────────────────────────────────────
    // Consumers see 'queued' before the worker's STARTED. Best-effort: the job is already
    // durable AND the answer is already recorded, so a marker-write failure loses nothing —
    // the worker still writes its own started/done/failed, and the poll route falls back to
    // pg-boss for the window where neither exists (W4 #TtWiD).
    try {
      await writeJobEvent(db, {
        business_table: JUDGE_RUN_TABLE,
        business_id: runId,
        event_type: JUDGE_RUN_EVENTS.QUEUED,
        payload: {
          caller: 'submit',
          question_id: validated.questionId,
          session_id: validated.body.session_id ?? null,
        },
      });
    } catch (markerErr) {
      console.error(
        '[submit] durable judge queued-marker write failed (non-fatal; poll falls back to pg-boss)',
        runId,
        markerErr,
      );
    }

    return durablePendingResponse(runId);
  } catch (err) {
    // Only the pending-attempt write reaches here (the enqueue has its own catch and the
    // marker never throws out), so nothing was recorded and nothing was enqueued — give the
    // admission token back.
    (deps.refundRateLimit ?? refundRateLimit)(rateLimitToken);
    return errorResponse(err);
  }
}

// ============================================================================
// Route — compose the three phases and shape the wire response.
// ============================================================================

export async function createAttempt(req: Request): Promise<Response> {
  try {
    const validated = await validateSubmit(req);
    // YUK-594 (W2) — async-main divert (dark-ship). When JUDGE_DURABLE_ENABLED is on
    // AND this submit would spend a synchronous server-side judge call, move the judge
    // to the durable `judge_run` lane and return 202-pending; the verdict + FSRS land
    // on the worker's backfill event. Flag OFF (default) → the whole block is skipped
    // → byte-identical synchronous behavior (the flag-off regression anchor).
    // `shouldEnqueueBackgroundJobs()` keeps the test/CI env on the synchronous path
    // (no worker to drain the queue), same guard the copilot durable dispatch uses.
    // #8 — when the divert gate already resolved the subject profile (the
    // photo-only-unsupported non-divert branch), reuse it for the synchronous
    // judgeSubmit below instead of resolving it a second time.
    let reusedProfile: SubjectProfile | null = null;
    if (judgeDurableEnabled() && shouldEnqueueBackgroundJobs()) {
      const gate = await resolveDurableDivert(validated);
      if (gate.divert && gate.subjectProfile !== null) {
        return await enqueueDurableJudge(validated, gate.subjectProfile);
      }
      reusedProfile = gate.subjectProfile;
    }
    const judged = await judgeSubmit(
      validated,
      reusedProfile ? { subjectProfile: reusedProfile } : {},
    );
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

export async function createAttemptResource(req: Request): Promise<Response> {
  const inner = await createAttempt(req);
  // YUK-594 — a durable divert returns 202-pending, whose body has NO `review_event`;
  // canonicalResourceResponse derives Location from `review_event.id`, so it would blow
  // up on the pending shape. Pass it through untouched — enqueueDurableJudge already set
  // its own Location header (the run's SSE stream), which is the correct resource.
  // #8 — keyed on the EXPLICIT divert header, not a bare 202: an unrelated future 202 from
  // this route must still go through the resource wrapper rather than leak a raw body.
  if (inner.headers.get(DURABLE_DIVERT_HEADER) === DURABLE_DIVERT_JUDGE) return inner;
  return canonicalResourceResponse(inner, {
    outcome: 'created',
    location: (body) =>
      `/api/events/${encodeURIComponent(
        (body as { review_event: { id: string } }).review_event.id,
      )}`,
  });
}

export async function POST(req: Request): Promise<Response> {
  return deprecatedRouteResponse(await createAttempt(req), '/api/attempts');
}
