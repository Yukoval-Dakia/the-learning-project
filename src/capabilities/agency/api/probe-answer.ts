// Grade the persisted probe original; only answerProbe writes its terminal outcome.
import { eq } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import { ConjectureProbeSpec, ConjectureProbeSpecV2 } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import { PROBE_QUESTION_INITIAL_VERSION } from '@/core/schema/conjecture';
import { AiProposalPayload } from '@/core/schema/proposal';
import { db } from '@/db/client';
import {
  assessment_issuance,
  event,
  question,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { ApiError, errorResponse } from '@/kernel/http';
import { previewFormalAttempt } from '@/kernel/judge';
import { freezeImageEvidence } from '@/kernel/records/assessment-evidence';
import { validateIssuedProbeProvenance } from '../server/conjecture/completed-probe-provenance';
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

    const [issuance] = await db
      .select()
      .from(assessment_issuance)
      .where(eq(assessment_issuance.issuance_id, `iss_probe_${probeQuestionId}`));
    if (!issuance)
      throw new ApiError('probe_not_issued', 'probe has no admitted frozen serve record', 409);
    const [revision] = await db
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, issuance.revision_id));
    const [lifecycle] = await db
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, probeQuestionId));
    if (
      !revision ||
      revision.group_id !== probeQuestionId ||
      lifecycle?.scoring_admission_state !== 'admitted' ||
      lifecycle.suspended ||
      lifecycle.withdrawn
    ) {
      throw new ApiError('not_admitted', 'probe is not available for automatic evaluation', 422);
    }
    const proposalId = metadata.conjecture_proposal_id;
    if (typeof proposalId !== 'string' || proposalId.length === 0) {
      throw new ApiError('probe_missing_conjecture_ref', 'probe has no proposal reference', 409);
    }
    const [proposalRow] = await db.select().from(event).where(eq(event.id, proposalId));
    const proposal = AiProposalPayload.safeParse(proposalRow?.payload.ai_proposal);
    if (!proposal.success || proposal.data.kind !== 'conjecture') {
      throw new ApiError('probe_proposal_invalid', 'probe proposal payload is invalid', 500);
    }
    const change = proposal.data.proposed_change;
    const issued = validateIssuedProbeProvenance({
      probe,
      issuance,
      revision,
      proposal: {
        id: proposalId,
        knowledgeId: change.knowledge_id,
        probeMd: change.probe_md,
        probeReferenceMd: change.probe_reference_md,
        probeSpec: change.probe_spec ?? null,
        followupProbeMd: change.followup_probe_md ?? null,
        followupProbeReferenceMd: change.followup_probe_reference_md ?? null,
        followupProbeSpec: change.followup_probe_spec ?? null,
      },
    });
    if ('reason' in issued) {
      throw new ApiError(
        issued.reason,
        'issued probe does not match its original proposal',
        issued.reason === 'unsupported_probe_contract' ? 422 : 409,
      );
    }
    const responseAwareProbeSpec = ConjectureProbeSpecV2.safeParse(
      issued.value.sequence === 2 ? change.followup_probe_spec : change.probe_spec,
    );
    const slot = revision.response_spec.slots[0];
    const evidence = await freezeImageEvidence(db, answerImageRefs);
    const responseSet = {
      entries: [{ slot_id: slot.slot_id, kind: 'open' as const, text_md: answerMd, evidence }],
    };
    const responseKey = canonicalHash(responseSet);

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
      const original = await previewFormalAttempt(
        db,
        'conjecture_probe',
        probeQuestionId,
        {
          issuance_id: issuance.issuance_id,
          evaluation_group_id: `probe:${probeQuestionId}:${responseKey}`,
          idempotency_key: responseKey,
          response_set: responseSet,
          group_evidence: [],
        },
        req.signal,
      );
      const invoked = original.candidate;
      const judgeResult = invoked.result;
      if (
        invoked.evaluation.record.provenance?.source !== 'automatic' ||
        invoked.evaluation.record.provenance.assisted
      ) {
        throw new ApiError(
          'probe_response_ungradable',
          'probe evidence must be an unassisted automatic evaluation',
          422,
        );
      }

      let outcome: 0 | 1 | null = mapGradingOutcome(judgeResult.coarse_outcome);
      const unit = invoked.evaluation.record.unit_results[0];
      const responseJudgement = responseAwareProbeSpec.success
        ? (unit?.probe_judgement ?? null)
        : null;
      if (responseAwareProbeSpec.success && !responseJudgement) {
        throw new ApiError(
          'probe_response_ungradable',
          'frozen signature judgement is missing',
          422,
        );
      }
      if (responseJudgement && !responseJudgement.gradable) {
        throw new ApiError(
          'probe_response_ungradable',
          `probe ${probeQuestionId} response could not be reconciled with its declared signatures (${responseJudgement.reason_code}); no conjecture evidence was written`,
          422,
        );
      }
      if (outcome === null) {
        // Fail-closed: NO probe_result written. The probe stays served-but-unanswered
        // (its slot is not consumed) so the owner can re-answer or resolve via admin.
        throw new ApiError(
          'unsupported_judge_route',
          `judge returned coarse_outcome='${judgeResult.coarse_outcome}' for probe ${probeQuestionId} (fail-closed: no probe_result written; probe stays active)`,
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
        taskRunId: invoked.evaluation.record.run_refs[0],
        assessment: {
          issuance_id: issuance.issuance_id,
          submission_id: original.submission.submission_id,
          evaluation_id: invoked.evaluation.record.evaluation_id,
        },
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
