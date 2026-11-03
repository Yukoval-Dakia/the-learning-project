// Owns judge_retraction accept: evaluation appeal/rejudge/assert, and legacy judge-event retract.

import { and, desc, eq } from 'drizzle-orm';

import { canonicalHash } from '@/core/migration/canonical';
import {
  ActivateEvaluationIntent,
  EvaluationProvenance,
  PublishedQuestionRevision,
  type ScoringUnitResultT,
  projectIssuedScoringBasis,
} from '@/core/schema/assessment';
import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { evaluation, event, question_revision } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';
import {
  asPlainRecord,
  ensureAcceptOnly,
  requiredString,
} from '@/kernel/proposals/applier-helpers';
import {
  type ProposalAcceptEffectOutcome,
  type ProposalAcceptRun,
  type RecordedProposalRate,
  runProposalAccept,
} from '@/kernel/proposals/decision-protocol';
import type { ProposalInboxRow } from '@/kernel/proposals/inbox';
// Narrow applier options: settlement depends on the kernel proposal engine, not
// question-bank's applier options (which mix in enqueueVariantVerify). The
// dispatch shell's AcceptAiProposalOpts stays structurally assignable.
export interface JudgeRetractionApplierOpts {
  decision?: string;
  user_note?: string;
  // swappable rejudge enqueue (DB tests inject a no-op or vi.fn).
  enqueueRejudge?: (appealEventId: string) => Promise<void>;
}

// ====================================================================
// judge_retraction accept applier（判分纠错提案的真身）
// ====================================================================
// 两类目标：
// - subject_kind='evaluation'（native 评价行）：按 proposed_change.correction_kind
// · rejudge → 写 experimental:appeal_request（expected head = 提案创建时
// 冻结的快照，允许非 effective 目标）→ rejudge job → 冻结输入重评 →
// CAS 激活 → settlement replay 自动回算 FSRS/θ/掌握度；
// · assert → 按 asserted_verdicts 产出 manual_assert candidate 并同步
// 激活 + 写 appeal resolution 事件。
// - subject_kind='event'（legacy judge event）：写 CorrectEvent(retract)，
// 命中既有 event 纠偏投影（corrections.ts）。
// 任何路径都不回写原评价/FSRS/掌握度 —— 全部走"新事件 + 新 candidate +
// 激活 + replay"的既有可逆机制。

export interface JudgeRetractionAcceptResult {
  kind: 'judge_retraction';
  rate_event_id: string | null;
  /** evaluation 目标：appeal_request/纠错锚点事件 id。 */
  correction_event_id?: string;
  /** assert 路径：新激活的 candidate evaluation id。 */
  corrected_evaluation_id?: string;
  /** rejudge → 'queued_rejudge'；assert → 激活态；event → 'retracted'。 */
  disposition: string;
  idempotent?: boolean;
}

async function defaultEnqueueRejudge(appealEventId: string): Promise<void> {
  const { getStartedBoss } = await import('@/server/boss/client');
  const { REJUDGE_SINGLETON_SECONDS } = await import('../jobs/rejudge-config');
  const boss = await getStartedBoss();
  await boss.send(
    'rejudge',
    { appeal_event_id: appealEventId },
    { singletonKey: appealEventId, singletonSeconds: REJUDGE_SINGLETON_SECONDS },
  );
}

async function writeCorrectionResolution(
  db: Db | Tx,
  input: {
    correctionEventId: string;
    evaluationSubjectId: string;
    disposition: string;
    evaluationId?: string;
  },
) {
  const id = `evt_eval_correction_resolution_${canonicalHash(input.correctionEventId)}`;
  const [existing] = await db.select({ id: event.id }).from(event).where(eq(event.id, id)).limit(1);
  if (existing) return;
  await writeEvent(db, {
    id,
    actor_kind: 'system',
    actor_ref: 'assessment:correction',
    action: 'experimental:assessment_appeal_resolution',
    subject_kind: 'evaluation',
    subject_id: input.evaluationSubjectId,
    outcome: null,
    caused_by_event_id: input.correctionEventId,
    payload: {
      disposition: input.disposition,
      ...(input.evaluationId ? { evaluation_id: input.evaluationId } : {}),
    },
  });
}

// applyManualAssertCorrection 的确定性校验失败：写一条 failed:<code> resolution，
// 但绝不落 accept —— 提案保持 pending，owner 可重试/驳回，而不是显示成已采纳却零效果。
const permanentAssertFailureCodes: ReadonlySet<string> = new Set([
  'not_correctable',
  'frozen_input_unavailable',
  'not_found',
  'assert_coverage_incomplete',
  'assert_unit_not_additive',
  'assert_unit_unknown',
  'evaluation_key_conflict',
]);

function permanentAssertFailureDisposition(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code =
    error instanceof ApiError
      ? error.code
      : error.name === 'EvaluateSubmissionError'
        ? (error as Error & { code?: string }).code
        : undefined;
  return code && permanentAssertFailureCodes.has(code) ? `failed:${code}` : null;
}

/** assert 路径：人工判定 → manual_assert candidate → CAS 激活 + resolution 事件。 */
async function applyManualAssertCorrection(
  db: Db | Tx,
  input: {
    proposalId: string;
    evaluationId: string;
    correctionEventId: string;
    reasonMd: string;
    assertedVerdicts: { scoring_unit_id: string; verdict: 'correct' | 'incorrect' }[];
    /** proposal 创建时冻结的 head 期望（P1 review）——CAS 按此比对，不现读。 */
    expectedHead: { effectiveEvaluationId: string | null; generation: number };
  },
): Promise<{ correctedEvaluationId: string; disposition: string }> {
  const { activateSubmissionCandidate, evaluateAttempt } = await import('../../grading/public');

  const [original] = await db
    .select()
    .from(evaluation)
    .where(eq(evaluation.evaluation_id, input.evaluationId))
    .limit(1);
  if (original?.status !== 'completed') {
    throw new ApiError('not_correctable', 'target evaluation missing or not completed', 409);
  }
  const provenance = EvaluationProvenance.safeParse(original.provenance);
  if (!provenance.success || !provenance.data.input_snapshot) {
    throw new ApiError(
      'frozen_input_unavailable',
      'assert correction requires the frozen input snapshot',
      409,
    );
  }
  const [revisionRow] = await db
    .select()
    .from(question_revision)
    .where(eq(question_revision.revision_id, provenance.data.input_snapshot.revision_id))
    .limit(1);
  if (!revisionRow) {
    throw new ApiError('not_found', 'frozen revision row missing for assert correction', 409);
  }
  const revision = PublishedQuestionRevision.parse({
    revision_id: revisionRow.revision_id,
    group_id: revisionRow.group_id,
    revision_ordinal: revisionRow.revision_ordinal,
    integrity_digest: revisionRow.integrity_digest,
    structure: revisionRow.structure,
    response_spec: revisionRow.response_spec,
    scoring_basis: revisionRow.scoring_basis,
    execution_plan: revisionRow.execution_plan,
    published_at:
      typeof revisionRow.published_at === 'string'
        ? revisionRow.published_at
        : revisionRow.published_at.toISOString(),
    supersedes_revision_id: revisionRow.supersedes_revision_id,
  });
  const scopedBasis = projectIssuedScoringBasis(
    revision,
    provenance.data.input_snapshot.issued_part_ids,
  );
  const verdicts = new Map(input.assertedVerdicts.map((v) => [v.scoring_unit_id, v.verdict]));
  // scopedBasis.units = 本次 issuance 发题范围内的全部 unit（assert 需全覆盖）。
  const scopedUnits = scopedBasis.units;
  const asserted: ScoringUnitResultT[] = scopedUnits.map((unit) => {
    const verdict = verdicts.get(unit.scoring_unit_id);
    if (verdict === undefined) {
      throw new ApiError(
        'assert_coverage_incomplete',
        `asserted_verdicts must cover every in-scope unit; missing '${unit.scoring_unit_id}'`,
        422,
      );
    }
    if (unit.points === null) {
      throw new ApiError(
        'assert_unit_not_additive',
        `unit '${unit.scoring_unit_id}' is not additive-scored — manual assert needs the holistic lane, which is not part of this correction path`,
        422,
      );
    }
    return {
      status: 'scored',
      scoring_unit_id: unit.scoring_unit_id,
      points_awarded: verdict === 'correct' ? unit.points : 0,
      scored_because: 'response',
      judged_by: 'human_review',
      feedback_md: input.reasonMd || undefined,
      evidence_citations: [],
    };
  });
  for (const v of input.assertedVerdicts) {
    if (!scopedUnits.some((unit) => unit.scoring_unit_id === v.scoring_unit_id)) {
      throw new ApiError(
        'assert_unit_unknown',
        `asserted_verdicts references unknown/out-of-scope unit '${v.scoring_unit_id}'`,
        422,
      );
    }
  }

  const candidate = await evaluateAttempt({
    db,
    entry: 'appeal_rejudge',
    contract: {
      submission_id: original.submission_id,
      evaluation_group_id: original.evaluation_group_id,
      expected_submission_ids: provenance.data.input_snapshot.member_submission_ids,
      evaluation_key: `correction:${input.proposalId}`,
      mode: 'manual_assert',
      asserted_unit_results: asserted,
      provenance: {
        source: 'manual',
        assisted: false,
        review_context: {
          appeal_event_id: input.correctionEventId,
          prior_evaluation_id: original.evaluation_id,
          reason_md: input.reasonMd,
        },
      },
    },
  });
  const candidateId = candidate.evaluation.record.evaluation_id;

  // P1 review — CAS 期望来自 proposal 冻结快照，不是 accept 时的现值：head
  // 已移动 ⇒ activation 返回 conflict，重放是非变异性的，绝不覆盖后到的 B。
  const intent = ActivateEvaluationIntent.parse({
    evaluation_id: candidateId,
    expected_effective_id: input.expectedHead.effectiveEvaluationId,
    expected_generation: input.expectedHead.generation,
  });
  let disposition: string;
  if (candidate.evaluation.record.status === 'completed') {
    const activation = await activateSubmissionCandidate(db, intent, {
      actorRef: 'assessment:correction',
      correction: {
        appealEventId: input.correctionEventId,
        priorEvaluationId: original.evaluation_id,
      },
      record: (tx) =>
        writeCorrectionResolution(tx, {
          correctionEventId: input.correctionEventId,
          evaluationSubjectId: original.evaluation_id,
          disposition: 'effective',
          evaluationId: candidateId,
        }),
    });
    disposition =
      activation.status === 'activated' || activation.status === 'already_effective'
        ? 'effective'
        : `held:${activation.status}`;
    if (disposition !== 'effective') {
      await writeCorrectionResolution(db, {
        correctionEventId: input.correctionEventId,
        evaluationSubjectId: original.evaluation_id,
        disposition,
        evaluationId: candidateId,
      });
    }
  } else {
    disposition = 'held:candidate_pending';
    await writeCorrectionResolution(db, {
      correctionEventId: input.correctionEventId,
      evaluationSubjectId: original.evaluation_id,
      disposition,
      evaluationId: candidateId,
    });
  }
  return { correctedEvaluationId: candidateId, disposition };
}

type ParsedRetractionTarget =
  | { lane: 'event'; judgeEventId: string }
  | {
      lane: 'evaluation';
      evaluationId: string;
      correctionKind: 'rejudge' | 'assert';
      expectedEffectiveId: string | null;
      expectedGeneration: number;
      assertedVerdicts: { scoring_unit_id: string; verdict: 'correct' | 'incorrect' }[];
    };

function eventCorrectionEventId(proposalId: string, judgeEventId: string): string {
  return `evt_event_correction_${canonicalHash({ proposal: proposalId, target: judgeEventId, kind: 'retract' })}`;
}

/** The latest terminal outcome written against a committed correction request. */
async function findLatestCorrectionResolution(
  db: Db,
  correctionEventId: string,
): Promise<{ disposition?: string; evaluationId?: string } | null> {
  const [row] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'experimental:assessment_appeal_resolution'),
        eq(event.caused_by_event_id, correctionEventId),
      ),
    )
    .orderBy(desc(event.created_at))
    .limit(1);
  if (!row) return null;
  const payload = asPlainRecord(row.payload);
  return {
    disposition: typeof payload.disposition === 'string' ? payload.disposition : undefined,
    evaluationId: typeof payload.evaluation_id === 'string' ? payload.evaluation_id : undefined,
  };
}

export async function acceptJudgeRetractionProposal(
  db: Db,
  proposalId: string,
  proposal: ProposalInboxRow,
  opts: JudgeRetractionApplierOpts,
): Promise<JudgeRetractionAcceptResult> {
  ensureAcceptOnly('judge_retraction', opts);
  const change = asPlainRecord(proposal.payload.proposed_change);
  const target = asPlainRecord(proposal.payload.target);
  const reasonMd =
    typeof change.reason_md === 'string'
      ? change.reason_md
      : typeof proposal.payload.reason_md === 'string'
        ? proposal.payload.reason_md
        : '';

  let parsed: ParsedRetractionTarget;
  if (target.subject_kind === 'evaluation') {
    const evaluationId = requiredString(change.evaluation_id, 'evaluation_id', proposalId);
    const correctionKind = change.correction_kind === 'assert' ? 'assert' : 'rejudge';
    // P1 review — 冻结的 head 期望必须随 proposal 落库（服务端观测，非 agent
    // 提供）。缺字段 ⇒ 无法证明观察时点，拒绝而不是悄悄按 accept 时的 head
    // 重订 —— 否则过期提案/重试会把后到的纠错 B 覆盖回 A。
    const expectedEffectiveId =
      change.expected_effective_id === null
        ? null
        : requiredString(change.expected_effective_id, 'expected_effective_id', proposalId);
    if (typeof change.expected_generation !== 'number' || change.expected_generation < 0) {
      throw new ApiError(
        'validation_error',
        `proposal ${proposalId} is missing required proposed_change.expected_generation`,
        400,
      );
    }
    const expectedGeneration = change.expected_generation;

    // assert payload 校验放在写 appeal request 之前：畸形提案不能留下无结论的
    // correction 事件。producer 已做同样的全覆盖校验，这里保留解析/兜底。
    let assertedVerdicts: { scoring_unit_id: string; verdict: 'correct' | 'incorrect' }[] = [];
    if (correctionKind === 'assert') {
      const rawVerdicts = Array.isArray(change.asserted_verdicts) ? change.asserted_verdicts : [];
      assertedVerdicts = rawVerdicts
        .map((v) => asPlainRecord(v))
        .map((v) => ({
          scoring_unit_id: typeof v.scoring_unit_id === 'string' ? v.scoring_unit_id : '',
          verdict: v.verdict === 'correct' ? ('correct' as const) : ('incorrect' as const),
        }));
      if (assertedVerdicts.length === 0 || assertedVerdicts.some((v) => v.scoring_unit_id === '')) {
        throw new ApiError(
          'validation_error',
          "correction_kind='assert' requires non-empty asserted_verdicts",
          400,
        );
      }
    }
    parsed = {
      lane: 'evaluation',
      evaluationId,
      correctionKind,
      expectedEffectiveId,
      expectedGeneration,
      assertedVerdicts,
    };
  } else {
    parsed = {
      lane: 'event',
      judgeEventId: requiredString(change.judge_event_id, 'judge_event_id', proposalId),
    };
  }

  let run: ProposalAcceptRun<JudgeRetractionAcceptResult>;
  try {
    run = await runProposalAccept(db, proposalId, {
      proposal,
      userNote: opts.user_note,
      signal: 'after_commit',
      replay: async (rate: RecordedProposalRate): Promise<JudgeRetractionAcceptResult> => {
        const ratePayload = asPlainRecord(rate.payload);
        if (parsed.lane === 'event') {
          return {
            kind: 'judge_retraction',
            rate_event_id: rate.id,
            correction_event_id: eventCorrectionEventId(proposalId, parsed.judgeEventId),
            disposition: 'retracted',
            idempotent: true,
          };
        }
        const correctionEventId =
          typeof ratePayload.correction_event_id === 'string'
            ? ratePayload.correction_event_id
            : (await import('./appeal')).evaluationCorrectionEventId(
                parsed.evaluationId,
                proposalId,
              );
        if (parsed.correctionKind === 'assert') {
          // Rates written before this decision template carry only `rating`; recover
          // the public result from the resolution the accept committed beside it.
          let correctedEvaluationId =
            typeof ratePayload.corrected_evaluation_id === 'string'
              ? ratePayload.corrected_evaluation_id
              : undefined;
          let disposition =
            typeof ratePayload.disposition === 'string' ? ratePayload.disposition : undefined;
          if (correctedEvaluationId === undefined || disposition === undefined) {
            const resolution = await findLatestCorrectionResolution(db, correctionEventId);
            correctedEvaluationId ??= resolution?.evaluationId;
            disposition ??= resolution?.disposition;
          }
          return {
            kind: 'judge_retraction',
            rate_event_id: rate.id,
            correction_event_id: correctionEventId,
            ...(correctedEvaluationId ? { corrected_evaluation_id: correctedEvaluationId } : {}),
            disposition: disposition ?? 'already_applied',
            idempotent: true,
          };
        }
        return {
          kind: 'judge_retraction',
          rate_event_id: rate.id,
          correction_event_id: correctionEventId,
          disposition: 'already_applied',
          idempotent: true,
        };
      },
      prepare: async () => {
        // The judge event row is immutable evidence; validate before the decision tx.
        if (parsed.lane !== 'event') return;
        const [judgeEvent] = await db
          .select()
          .from(event)
          .where(eq(event.id, parsed.judgeEventId))
          .limit(1);
        if (judgeEvent?.action !== 'judge') {
          throw new ApiError(
            'evidence_ref_must_be_judge_event',
            'target event is not a judge event',
            422,
          );
        }
      },
      // The kernel holds the proposal decision lock for this whole transaction. The
      // assert lane reaches activation, which acquires the learning-state write
      // lock G before the group lock; G therefore goes first here so the effect
      // keeps the documented G → group → rows order instead of group → G.
      effect: async ({
        tx,
        writeRate,
      }): Promise<ProposalAcceptEffectOutcome<JudgeRetractionAcceptResult>> => {
        if (parsed.lane === 'event') {
          const correctionEventId = eventCorrectionEventId(proposalId, parsed.judgeEventId);
          // Deterministic id: a previously committed retract of the same target
          // inserts nothing (writeEvent dedups on id conflict).
          await writeEvent(tx, {
            id: correctionEventId,
            actor_kind: 'user',
            actor_ref: 'self',
            action: 'correct',
            subject_kind: 'event',
            subject_id: parsed.judgeEventId,
            outcome: 'success',
            payload: {
              correction_kind: 'retract',
              reason_md: reasonMd || 'judge_retraction proposal accepted',
              affected_refs: [{ kind: 'event', id: parsed.judgeEventId }],
            },
            caused_by_event_id: proposalId,
          });
          const rateEventId = await writeRate({
            payload: {
              correction_event_id: correctionEventId,
              correction_kind: 'retract',
              disposition: 'retracted',
            },
          });
          return {
            status: 'accepted',
            result: {
              kind: 'judge_retraction',
              rate_event_id: rateEventId,
              correction_event_id: correctionEventId,
              disposition: 'retracted',
            },
          };
        }

        if (parsed.correctionKind === 'assert') await acquireLearningStateWriteLock(tx);
        const { requestEvaluationCorrection } = await import('./appeal');
        const correctionEventId = await requestEvaluationCorrection(tx, {
          evaluation_id: parsed.evaluationId,
          reason_md: reasonMd,
          proposal_event_id: proposalId,
          expected_effective_id: parsed.expectedEffectiveId,
          expected_generation: parsed.expectedGeneration,
        });

        if (parsed.correctionKind === 'rejudge') {
          const rateEventId = await writeRate({
            payload: {
              correction_event_id: correctionEventId,
              correction_kind: 'rejudge',
              disposition: 'queued_rejudge',
            },
          });
          return {
            status: 'accepted',
            result: {
              kind: 'judge_retraction',
              rate_event_id: rateEventId,
              correction_event_id: correctionEventId,
              disposition: 'queued_rejudge',
            },
          };
        }

        // assert 幂等：manual_assert 的 evaluation_key（correction:<proposalId>）在
        // evaluateSubmission 里按 intent_digest 重放同一 candidate；activation CAS
        // 以 proposal 冻结期望比对 —— head 已动则 conflict（非变异性），命中已激
        // 活则 already_effective；resolution 事件按确定性 id 只写一次。
        const outcome = await applyManualAssertCorrection(tx, {
          proposalId,
          evaluationId: parsed.evaluationId,
          correctionEventId,
          reasonMd,
          assertedVerdicts: parsed.assertedVerdicts,
          expectedHead: {
            effectiveEvaluationId: parsed.expectedEffectiveId,
            generation: parsed.expectedGeneration,
          },
        });
        const rateEventId = await writeRate({
          payload: {
            correction_event_id: correctionEventId,
            correction_kind: 'assert',
            disposition: outcome.disposition,
            corrected_evaluation_id: outcome.correctedEvaluationId,
          },
        });
        return {
          status: 'accepted',
          result: {
            kind: 'judge_retraction',
            rate_event_id: rateEventId,
            correction_event_id: correctionEventId,
            corrected_evaluation_id: outcome.correctedEvaluationId,
            disposition: outcome.disposition,
          },
        };
      },
    });
  } catch (error) {
    // accept rate 必须写在效果之后：确定性校验失败时提案保持 pending。
    // correction request 在裁决事务里随失败回滚；补偿按迁移前的独立事务语义
    // 单独提交同一幂等请求 + 终态 resolution，不让已落 appeal 无结论。
    const disposition = permanentAssertFailureDisposition(error);
    if (disposition && parsed.lane === 'evaluation' && parsed.correctionKind === 'assert') {
      try {
        const { requestEvaluationCorrection } = await import('./appeal');
        const correctionEventId = await requestEvaluationCorrection(db, {
          evaluation_id: parsed.evaluationId,
          reason_md: reasonMd,
          proposal_event_id: proposalId,
          expected_effective_id: parsed.expectedEffectiveId,
          expected_generation: parsed.expectedGeneration,
        });
        await writeCorrectionResolution(db, {
          correctionEventId,
          evaluationSubjectId: parsed.evaluationId,
          disposition,
        });
      } catch (compensationError) {
        console.warn('[acceptJudgeRetractionProposal] failed-resolution compensation degraded', {
          proposal_id: proposalId,
          error:
            compensationError instanceof Error
              ? compensationError.message
              : String(compensationError),
        });
      }
    }
    throw error;
  }

  if (
    (run.outcome === 'accepted' || run.outcome === 'replayed') &&
    parsed.lane === 'evaluation' &&
    parsed.correctionKind === 'rejudge' &&
    run.result.correction_event_id
  ) {
    // Post-commit, so a crash or a failed send after the decision commits would strand the
    // appeal with no sweep to find it; a replayed accept re-sends to heal that. The singleton
    // key (appeal event id) and the resolved-appeal early exit make a duplicate send harmless.
    try {
      await (opts.enqueueRejudge ?? defaultEnqueueRejudge)(run.result.correction_event_id);
    } catch (err) {
      console.error('[acceptJudgeRetractionProposal] enqueue rejudge failed after commit', err);
    }
  }
  return run.result;
}
