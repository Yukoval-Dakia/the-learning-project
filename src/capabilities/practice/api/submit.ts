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
//   settleInlineSoloReview (sealed learning-state command + post-commit
//   signals). POST composes validation/judging with that command and shapes the
//   wire response.

import { and, eq } from 'drizzle-orm';
import type { Provider } from '@/ai/registry';
import { questionKnowledgeIdsForJudge } from '@/capabilities/practice/server/intervention-diagnostics';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  type createDefaultJudgeInvoker,
  deterministicExecutionProvenance,
  evaluateAttempt,
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
} from '@/capabilities/practice/server/judge';
import type { JudgeResultV2T } from '@/core/schema/capability';
// YUK-471 Wave 0 (ADR-0044 §3) — FSRS Card type for the per-subject snapshot `before`.
import type { JudgeExecutionProvenanceT } from '@/core/schema/event/known';
import {
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
  InterventionDiagnosticQuestionMetadata,
} from '@/core/schema/intervention';
import { type Db, db } from '@/db/client';
import { learning_session, question } from '@/db/schema';
import {
  ApiError,
  canonicalResourceResponse,
  deprecatedRouteResponse,
  errorResponse,
} from '@/kernel/http';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { checkRateLimit } from '@/server/http/rate-limit';
import { shouldEnqueueBackgroundJobs } from '@/server/runtime-env';
import type { SubjectProfile } from '@/subjects/profile';
import { normalizeReviewSubmitActivityRef } from '../server/activity-ref';
import { commitFormalAttempt } from '../server/assessment/attempt';
import { resolveAdviceCauseForQuestion } from '../server/cause-context';
import { judgeDurableEnabled } from '../server/judge-durable-config';
import { ratingFromCoarseOutcome } from '../server/judge-rating';
import { JUDGE_RUN_TABLE } from '../server/judge-run-status';
import { type CreateAttemptBody, CreateAttemptBodySchema } from './contracts';

type Rating = CreateAttemptBody['rating'];
type SubmitBodyT = CreateAttemptBody;
type QuestionRow = typeof question.$inferSelect;

// F4 (PR #309 round-2, YUK-215) — the image-consuming judge routes set is now
// shared via the `@/capabilities/practice/server/judge` facade (IMAGE_CONSUMING_JUDGE_ROUTES) so
// the photo-only gate cannot drift between this single-question flow and the
// paper-submit flow (F1).

// ============================================================================
// Phase 1 — validate: parse body, resolve review identity, load question row.
// ============================================================================

export interface ValidatedSubmit {
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
  if (q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) {
    const diagnostic = InterventionDiagnosticQuestionMetadata.safeParse(
      q.metadata?.intervention_diagnostic,
    );
    if (!diagnostic.success) {
      throw new ApiError(
        'corrupt_state',
        `intervention diagnostic ${questionId} has invalid scheduling metadata`,
        500,
      );
    }
    if (q.judge_kind_override !== 'multimodal_direct') {
      throw new ApiError(
        'corrupt_state',
        `intervention diagnostic ${questionId} is missing its response-aware judge contract`,
        500,
      );
    }
    if (now.getTime() < new Date(diagnostic.data.due_at).getTime()) {
      throw new ApiError(
        'conflict',
        `intervention diagnostic ${questionId} is not due until ${diagnostic.data.due_at}`,
        409,
      );
    }
    if ((body.response_md?.trim().length ?? 0) === 0 && body.answer_image_refs.length === 0) {
      throw new ApiError(
        'validation_error',
        `intervention diagnostic ${questionId} requires an answer`,
        400,
      );
    }
  }

  return { body, now, questionId, activityRef: identity.activity_ref, q };
}

async function claimInterventionDiagnosticSubmission(validated: ValidatedSubmit): Promise<boolean> {
  if (validated.q.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) return false;

  const [claimed] = await db
    .update(question)
    .set({ draft_status: 'draft', updated_at: validated.now })
    .where(
      and(
        eq(question.id, validated.questionId),
        eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
        eq(question.draft_status, 'active'),
      ),
    )
    .returning({ id: question.id });
  if (!claimed) {
    throw new ApiError(
      'conflict',
      `intervention diagnostic ${validated.questionId} has already been submitted`,
      409,
    );
  }
  return true;
}

export async function releaseInterventionDiagnosticSubmissionClaim(
  input: { questionId: string; claimedAt: Date },
  database: Db = db,
): Promise<void> {
  await database
    .update(question)
    .set({ draft_status: 'active', updated_at: new Date() })
    .where(
      and(
        eq(question.id, input.questionId),
        eq(question.source, INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE),
        eq(question.draft_status, 'draft'),
        eq(question.updated_at, input.claimedAt),
      ),
    );
}

export function assertTrustedInterventionDiagnosticJudgment(
  q: QuestionRow,
  judged: Pick<JudgedSubmit, 'judgeResult' | 'judgeRoute' | 'executionProvenance'>,
): void {
  if (q.source !== INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE) return;
  if (
    judged.judgeResult === null ||
    judged.judgeRoute !== 'multimodal_direct' ||
    (judged.executionProvenance?.kind !== 'invoked' &&
      judged.executionProvenance?.kind !== 'supplied_verified')
  ) {
    throw new ApiError(
      'unsupported_judge_route',
      `intervention diagnostic ${q.id} requires a verified judge execution`,
      422,
    );
  }
}

// ============================================================================
// Phase 2 — judge: resolve judge result + final rating, all OUTSIDE the FSRS
// transaction (read-only; no events written).
// ============================================================================

export interface JudgedSubmit {
  judgeResult: JudgeResultV2T | null;
  judgeRoute: string | null;
  judgeTelemetry:
    | Awaited<ReturnType<ReturnType<typeof createDefaultJudgeInvoker>['invoke']>>['telemetry']
    | null;
  executionProvenance: JudgeExecutionProvenanceT | null;
  suggestedRating: Rating | null;
  finalRating: Rating;
  adviceCauseCategory: Awaited<ReturnType<typeof resolveAdviceCauseForQuestion>>;
  /**
   * YUK-739 — the profile the rating-advisory lean/ratingPolicy resolves
   * through (null when no answer was submitted, matching judgeSubmit's
   * subjectProfile resolution).
   */
  adviceSubjectProfile: SubjectProfile | null;
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
  // CC-3 invariant (YUK-1047): route through `evaluateAttempt` — the single
  // funnel seam — never call `judgeExact` / `judgeKeyword` / `judgeRouter`
  // or the invoker directly.
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
    ? (opts.subjectProfile ??
      (await resolveSubjectProfileForKnowledgeIds(db, questionKnowledgeIdsForJudge(q))))
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
    // YUK-1047 — all authoritative grading flows through evaluateAttempt (the
    // single funnel seam). Sync submits pass entry='solo_submit'; the durable
    // judge_run worker (which reaches this function via judgeSubmitFn) passes
    // entry='durable_judge_run'. The legacy lane (no contract submission yet,
    // YUK-1052 pending) returns the JudgeInvoker result verbatim.
    const invoked = await evaluateAttempt({
      entry: opts.durable ? 'durable_judge_run' : 'solo_submit',
      legacy: {
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
      },
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
    adviceSubjectProfile: subjectProfile,
  };
}

// ============================================================================
// Phase 3 — persist: knowledge-set resolution + FSRS transaction (advisory
// locks → schedule → review event → state upsert) + post-txn refine trigger.
// ============================================================================

// Learning-state persistence is owned by the sealed settlement commands in
// ../server/review-settlement. This module retains request validation, judging,
// durable admission, and HTTP response shaping.

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

export async function createAttempt(req: Request): Promise<Response> {
  let claimedDiagnostic: ValidatedSubmit | null = null;
  let retainDiagnosticClaim = false;
  try {
    const validated = await validateSubmit(req);
    if (!validated.body.assessment) {
      throw new ApiError(
        'historical_unknown',
        'solo submission requires its original issued assessment',
        409,
      );
    }
    if (await claimInterventionDiagnosticSubmission(validated)) {
      claimedDiagnostic = validated;
    }
    {
      const { body, questionId } = validated;
      if (!body.self_report && !body.activation_intent) {
        const { dispatchNativeAttempt } = await import('../server/assessment/durable-attempt');
        const runId = await dispatchNativeAttempt(
          db,
          questionId,
          { ...body.assessment!, now: validated.now },
          {
            enabled:
              judgeDurableEnabled() &&
              shouldEnqueueBackgroundJobs() &&
              (await sessionAdmitsDurableDivert(body.session_id ?? null)),
            capture: body,
            userRating: body.auto_rate ? undefined : body.rating,
            requireUnassistedModelEvidence:
              validated.q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
          },
        );
        if (runId) {
          retainDiagnosticClaim = true;
          return durablePendingResponse(runId);
        }
      }
      const committed = await commitFormalAttempt(
        db,
        'solo_submit',
        questionId,
        validated.body.assessment,
        {
          activationIntent: body.activation_intent,
          selfReport: body.self_report,
          userRating: body.auto_rate ? undefined : body.rating,
          capture: body,
          signal: req.signal,
          requireUnassistedModelEvidence:
            validated.q.source === INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
        },
      );
      retainDiagnosticClaim = true;
      const judged = committed.candidate.result;
      return Response.json({
        status: committed.status,
        assessment: {
          submission_id: committed.submission.submission_id,
          evaluation_group_id: committed.submission.evaluation_group_id,
          candidate_id: committed.candidate.evaluation.record.evaluation_id,
          activation_intent: committed.activation_intent,
          effect: committed.status === 'effective' ? committed.activation.effect : null,
        },
        review_event: { id: committed.attempt_id },
        judge: body.self_report
          ? null
          : {
              route: 'evaluate_submission',
              score: judged.score,
              coarse_outcome: judged.coarse_outcome,
              confidence: judged.confidence,
              feedback_md: judged.feedback_md,
              evidence_json: judged.evidence_json,
              capability_ref: judged.capability_ref,
              suggested_rating: ratingFromCoarseOutcome(judged.coarse_outcome),
              auto_rated: body.auto_rate,
              judge_event_id: null,
            },
      });
    }
  } catch (err) {
    if (claimedDiagnostic !== null && !retainDiagnosticClaim) {
      await releaseInterventionDiagnosticSubmissionClaim({
        questionId: claimedDiagnostic.questionId,
        claimedAt: claimedDiagnostic.now,
      }).catch((releaseError) => {
        console.error(
          `failed to release intervention diagnostic submission claim for ${claimedDiagnostic?.questionId}:`,
          releaseError,
        );
      });
    }
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
