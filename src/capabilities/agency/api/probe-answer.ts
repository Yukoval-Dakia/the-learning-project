// conjecture-wire #13 (YUK-538 ⑬ / spec §6 S3) — probe answer route.
//
// The CONSUMER half of the dark-loop: the owner answers a served probe and this
// route closes the lifecycle.
//
// ND-5 RED LINE — the boundary is `answerProbe`, NOT the judge dispatch:
//   - the judge is invoked via `createDefaultJudgeInvoker().invoke()` — the SAME
//     pure-evaluation chokepoint submit.ts uses. `JudgeInvoker.invoke()` resolves
//     the route, runs the judge (incl. the real `runSemanticJudge` async LLM path
//     for free-text probes), and emits telemetry. It does NOT write FSRS /
//     attempt / θ̂ — the FSRS write in submit.ts happens AFTER the judge call, in
//     submit's own code, not inside the invoker (verified: `invoker.ts` has zero
//     fsrs/attempt/event writes). The invoker is judge-only.
//   - this route writes a paid-judge claim marker before invoking the model, then
//     `answerProbe` writes exactly ONE `experimental:probe_result` outcome event
//     and may serve the pre-authored follow-up question. Neither path writes
//     attempt / FSRS / learner-state rows.
//   - the earlier "isolated registry path" (`resolveJudge().run()`) was a
//     defect (review PR #705 CRITICAL): the base registry's semantic runner is a
//     profile-validation STUB returning coarse_outcome='unsupported' — so every
//     free-text probe fail-closed 422 and no probe_result was ever written. The
//     invoker path is the ONLY path that actually evaluates free-text.
//
// YUK-787/YUK-827 outcome→resolution split:
//   - Historical probes without a response contract retain the coarse outcome
//     mapping for compatibility.
//   - Response-aware probes advance outcome=0 only when the same judge call
//     classifies the learner response as the declared target-error signature.
//     A generic wrong answer, missing match, ambiguity, snapshot drift, or a
//     correctness/signature conflict writes no evidence.
//   - A correctness verdict that also matches the gold signature maps to
//     outcome=1 → resolution='retired' (the conjecture is falsified).
//
// Fail-closed (spec §6 S3): judge 'unsupported' (reference missing / kind
// mismatch) OR 'partial' (ambiguous on a discriminating probe) → 422, NO
// probe_result written, the probe stays served-but-unanswered. A partial does
// not discriminate cleanly; injecting ambiguous evidence into an n=1
// calibration anchor would poison the soft-track signal. The owner can re-answer
// after the paid-judge claim cooldown or resolve via the admin reader (S4).
//
// Idempotency: a cheap `peekExistingProbeResult` pre-check short-circuits a
// re-answer to the RECORDED outcome/resolution WITHOUT invoking the judge (LLM
// cost guard — mirrors acceptConjectureProposal's `existingAcceptRate` pattern).
// A corrupt existing row falls through to `answerProbe`, which surfaces it as a
// `probe_result_corrupt` 500 (never papered over).

import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/public';
import {
  ConjectureProbeSpec,
  ConjectureProbeSpecV2,
  JudgeKind,
  QuestionKind,
} from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import { PROBE_QUESTION_INITIAL_VERSION } from '@/core/schema/conjecture';
import {
  ConjectureProbeSignatureMatch,
  classifyConjectureProbeResponseFromJudgeMatch,
} from '@/core/schema/conjecture-probe-response';
import { db } from '@/db/client';
import { question } from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import {
  IMAGE_CONSUMING_JUDGE_ROUTES,
  createDefaultJudgeInvoker,
  resolveQuestionJudgeRoute,
} from '@/kernel/judge';
import { checkRateLimit } from '@/server/http/rate-limit';
import { eq } from 'drizzle-orm';
import {
  type AnswerProbeResult,
  answerProbe,
  assertProbeJudgeReady,
  claimProbeJudging,
  peekExistingProbeResult,
  releaseProbeJudging,
} from '../server/conjecture/probe-lifecycle';
import { ProbeAnswerBodySchema, ProbeAnswerParamsSchema } from './contracts';

/**
 * Map the judge's coarse outcome onto grading only. Conjecture-survival resolution
 * is a separate historical fold inside `answerProbe`.
 *
 * 'incorrect'   → outcome=0
 * 'correct'     → outcome=1
 * 'partial' / 'unsupported' → null (fail closed)
 */
function mapGradingOutcome(coarse: JudgeResultV2T['coarse_outcome']): 0 | 1 | null {
  switch (coarse) {
    case 'incorrect':
      return 0;
    case 'correct':
      return 1;
    case 'partial':
    case 'unsupported':
      return null;
  }
}

function responseJudgementFields(
  result: Pick<AnswerProbeResult, 'response_judgement' | 'degradation_reason'>,
) {
  return {
    answer_result: result.response_judgement?.answer_result ?? null,
    target_error_match: result.response_judgement?.target_error_match ?? null,
    gradable: result.response_judgement?.gradable ?? null,
    response_reason_code: result.response_judgement?.reason_code ?? null,
    response_evidence_refs: result.response_judgement?.evidence_refs ?? null,
    signature_match_explanation_md:
      result.response_judgement?.signature_match_explanation_md ?? null,
    ...(result.degradation_reason ? { degradation_reason: result.degradation_reason } : {}),
  };
}

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const parsedParams = ProbeAnswerParamsSchema.safeParse(params);
    if (!parsedParams.success) {
      throw new ApiError('validation_error', 'probe question id is required', 400);
    }
    const probeQuestionId = parsedParams.data.id;

    // Intentional null fallback: an unparseable body is treated as an invalid
    // request (→ 400 below), NOT a 500. This is request-validation gating, not a
    // swallowed error — safeParse(null) produces a clear validation failure.
    const raw = await req.json().catch(() => null);
    const parsed = ProbeAnswerBodySchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'validation_error',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        400,
      );
    }
    const { answer_md: answerMd, answer_image_refs: answerImageRefs } = parsed.data;

    // Load the probe question row. Only `source='mind_probe'` rows are answerable
    // here — a non-probe question id is a 409 (this endpoint is conjecture-probe
    // scoped, NOT a general answer surface; regular submits go through /api/review/submit).
    const [probe] = await db
      .select()
      .from(question)
      .where(eq(question.id, probeQuestionId))
      .limit(1);
    if (!probe) {
      throw new ApiError('not_found', `probe question ${probeQuestionId} not found`, 404);
    }
    if (probe.source !== 'mind_probe') {
      throw new ApiError(
        'not_a_probe',
        `question ${probeQuestionId} is not a mind_probe (source='${probe.source}')`,
        409,
      );
    }

    // Idempotency pre-check (LLM cost guard): if a probe_result is already
    // recorded, short-circuit to the RECORDED values WITHOUT invoking the judge.
    // answerProbe re-validates on its own locked path; peek is the cheap read-only
    // front door. `coarse_outcome: null` signals "not judged this call".
    const existing = await peekExistingProbeResult(db, probeQuestionId);
    if (existing) {
      return Response.json({
        status: existing.status,
        resolution: existing.status,
        outcome: existing.outcome,
        probe_result_event_id: existing.probe_result_event_id,
        coarse_outcome: null,
        ...responseJudgementFields(existing),
        idempotent: true,
      });
    }

    // Early fail-closed on a corrupt / unknown question kind BEFORE spending an
    // LLM call. The DB `kind` column is free-form text; safeParse guards against
    // garbage. (The invoker's own route resolution would also catch this, but
    // later — this guard saves the LLM cost on a corrupt row.)
    const kindParsed = QuestionKind.safeParse(probe.kind);
    if (!kindParsed.success) {
      throw new ApiError(
        'unsupported_judge_route',
        `probe ${probeQuestionId} has unknown question kind '${probe.kind}'`,
        422,
      );
    }
    const overrideParsed = probe.judge_kind_override
      ? JudgeKind.safeParse(probe.judge_kind_override)
      : null;
    // NOTE: `safeParse()` returns a truthy result object whether success or
    // failure — the guard must check `.success`, NOT truthiness of the result
    // (a plain `!overrideParsed` is always false here, since SafeParseReturnType
    // is always a truthy object). Caught by CodeRabbit + OCR review (PR #705).
    if (overrideParsed && !overrideParsed.success) {
      throw new ApiError(
        'unsupported_judge_route',
        `probe ${probeQuestionId} has unknown judge_kind_override '${probe.judge_kind_override}'`,
        422,
      );
    }

    // Fail malformed proposal provenance before claiming or paying the judge.
    // Well-formed v1 proposals remain answerable under answerProbe's terminal legacy
    // rule, while v2 proposals continue through the recurrence gate.
    await assertProbeJudgeReady(db, probeQuestionId);
    const metadata =
      probe.metadata !== null &&
      typeof probe.metadata === 'object' &&
      !Array.isArray(probe.metadata)
        ? (probe.metadata as Record<string, unknown>)
        : {};
    const authoredProbeSpec =
      metadata.probe_spec === undefined ? null : ConjectureProbeSpec.safeParse(metadata.probe_spec);
    if (authoredProbeSpec !== null && !authoredProbeSpec.success) {
      throw new ApiError(
        'probe_snapshot_invalid',
        `probe ${probeQuestionId} has an invalid authored snapshot; no conjecture evidence was written`,
        409,
      );
    }
    const responseAwareProbeSpec = ConjectureProbeSpecV2.safeParse(
      authoredProbeSpec?.success ? authoredProbeSpec.data : undefined,
    );
    if (
      authoredProbeSpec?.success &&
      (probe.version !== PROBE_QUESTION_INITIAL_VERSION ||
        probe.prompt_md !== authoredProbeSpec.data.prompt_md ||
        probe.reference_md !== authoredProbeSpec.data.reference_md)
    ) {
      throw new ApiError(
        'probe_snapshot_changed',
        `probe ${probeQuestionId} no longer matches its immutable authored snapshot; no conjecture evidence was written`,
        409,
      );
    }

    // Judge via the standard invoker chokepoint (same path submit.ts uses).
    // `resolveSubjectProfileForKnowledgeIds` always returns a profile (falls back
    // to default on unresolvable knowledge id), so no null guard needed. ND-5
    // preserved: invoke() is judge-only (zero FSRS/attempt writes); answerProbe owns
    // the result write and the optional pre-authored follow-up question below.
    const subjectProfile = await resolveSubjectProfileForKnowledgeIds(
      db,
      probe.knowledge_ids ?? [],
    );
    // Photo-only gate (mirrors submit.ts F4): a photo-only answer is judgeable ONLY
    // by an image-consuming route (steps / multimodal_direct). On a text-only route
    // the empty answer_md would be graded as wrong and poison the n=1 anchor — so
    // fail-closed 422 (no probe_result written; the probe stays served, re-answerable).
    // NOTE: serveProbeOnce stamps judge_kind_override='multimodal_direct' on every probe,
    // so in practice this gate never fires — it's defense-in-depth if that policy changes.
    const photoOnly = answerMd.length === 0 && answerImageRefs.length > 0;
    if (photoOnly) {
      const route = resolveQuestionJudgeRoute(probe, subjectProfile);
      if (!IMAGE_CONSUMING_JUDGE_ROUTES.has(route)) {
        throw new ApiError(
          'unsupported_judge_route',
          `photo-only answer but probe ${probeQuestionId} routes to text-only judge '${route}' (fail-closed: probe stays active)`,
          422,
        );
      }
    }

    // YUK-691 — close both amplification dimensions immediately before the paid
    // call: the process-wide AI budget bounds bursts across probes, while the
    // persisted per-probe claim closes concurrent read-then-judge races.
    const claimedResult = await claimProbeJudging(db, probeQuestionId);
    if (claimedResult) {
      return Response.json({
        status: claimedResult.status,
        resolution: claimedResult.status,
        outcome: claimedResult.outcome,
        probe_result_event_id: claimedResult.probe_result_event_id,
        coarse_outcome: null,
        ...responseJudgementFields(claimedResult),
        idempotent: true,
      });
    }
    try {
      // Charge the shared budget only after this request owns the paid slot.
      checkRateLimit();
      const invoked = await createDefaultJudgeInvoker().invoke({
        db,
        question: probe,
        answer_md: answerMd,
        student_image_refs: answerImageRefs,
        subjectProfile,
      });
      const judgeResult = invoked.result;

      let outcome: 0 | 1 | null = mapGradingOutcome(judgeResult.coarse_outcome);
      if (outcome === null) {
        // Fail-closed: NO probe_result written. The probe stays served-but-unanswered
        // (its slot is not consumed) so the owner can re-answer or resolve via admin.
        throw new ApiError(
          'unsupported_judge_route',
          `judge returned coarse_outcome='${judgeResult.coarse_outcome}' for probe ${probeQuestionId} (fail-closed: no probe_result written; probe stays active)`,
          422,
        );
      }
      const signatureMatch = ConjectureProbeSignatureMatch.safeParse(
        judgeResult.evidence_json.probe_signature_match,
      );
      const responseJudgement = responseAwareProbeSpec.success
        ? classifyConjectureProbeResponseFromJudgeMatch(
            judgeResult.coarse_outcome,
            signatureMatch.success ? signatureMatch.data : undefined,
          )
        : null;
      if (responseJudgement && !responseJudgement.gradable) {
        throw new ApiError(
          'probe_response_ungradable',
          `probe ${probeQuestionId} response could not be reconciled with its declared signatures (${responseJudgement.reason_code}); no conjecture evidence was written`,
          422,
        );
      }
      if (responseJudgement) {
        outcome =
          responseJudgement.answer_result === 'correct'
            ? 1
            : responseJudgement.target_error_match === 'matched'
              ? 0
              : null;
      }

      const result = await answerProbe({
        db,
        probeQuestionId,
        outcome,
        answer_md: answerMd,
        answer_image_refs: answerImageRefs,
        response_judgement: responseJudgement,
      });

      // The response reports the RECORDED outcome/resolution (from answerProbe).
      // On an idempotent race the stored values win; this call's coarse outcome is
      // informational and cannot reinterpret the immutable result.
      return Response.json({
        status: result.status,
        resolution: result.status,
        outcome: result.outcome,
        probe_result_event_id: result.probe_result_event_id,
        coarse_outcome: judgeResult.coarse_outcome,
        ...responseJudgementFields(result),
        idempotent: result.idempotent ?? false,
      });
    } catch (err) {
      await releaseProbeJudging(db, probeQuestionId).catch((releaseErr) => {
        console.error(
          `[probe-answer] failed to release judge claim for ${probeQuestionId}`,
          releaseErr,
        );
      });
      throw err;
    }
  } catch (err) {
    return errorResponse(err);
  }
}
