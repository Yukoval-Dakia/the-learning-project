import { createHash } from 'node:crypto';
import { resolveTaskBudget } from '@/capabilities/task-registry';
import { isPublicSharedMaterial } from '@/core/schema/assessment/materials';
import { createAssessmentAssetLoader } from '../../../grading/public';
import { AdmissionAttemptExhausted } from './attempt';

// One admission operation: structural checks, blind solves, semantic adjudication,
// then deterministic probes or the system-admitted AI grader. Publication is append-only.

import { canonicalHash } from '@/core/migration/canonical';
import {
  LEGACY_QUESTION_ADMISSION_POLICY_ID,
  PREVIOUS_QUESTION_ADMISSION_POLICY_ID,
  QUESTION_ADMISSION_POLICY_ID,
} from '@/core/question-admission-policy';
import { declaredShapeSupport } from '@/core/schema/assessment/blank-answer-compare';
import { type ExecutionPlanT, validateExecutionPlan } from '@/core/schema/assessment/execution';
import { type ResponseSlotT, validateResponseSpec } from '@/core/schema/assessment/response';
import type { PublishedQuestionRevisionT } from '@/core/schema/assessment/revision';
import type {
  ScoringBasisT,
  ScoringUnitCriterionT,
  ScoringUnitT,
} from '@/core/schema/assessment/scoring';
import { validateScoringBasis } from '@/core/schema/assessment/scoring';
import type { ScoringRuleT } from '@/core/schema/assessment/scoring-rule';
import { validateStructure } from '@/core/schema/assessment/structure';
import type { Db } from '@/db/client';
import { resolveModelAdmissionContext } from '@/kernel/read-models/model-admission';
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import { type BoundRunTaskTextFn, makeRunTaskTextFn } from '@/server/ai/runner-fn';
import type { SubjectProfile } from '@/subjects/profile';
import type { AdmissionRepairT } from '../../tasks/question-admission-adjudicate';
import { adjudicateAdmission } from './adjudicate';
import {
  type AdmissionProbe,
  type ProbeOutcome,
  freezeProbes,
  methodFingerprint,
  probeSetDigest,
  runCalibrationProbes,
} from './calibrate';
import type { AdmissionUnitSpec, QuestionAdmissionDefinition } from './contract';
import { prepareAdmissionQuestionText } from './question-text';
import type { KnowledgeCandidate, SolutionPriorRecordT } from './solution-prior';
import {
  type AdmissionImage,
  type AdmissionKey,
  type AdmissionSolveReceipt,
  type Provider,
  type SolutionPriorPassResult,
  type UnitSolveVerdict,
  keyFromAnswer,
  runDualSolve,
  runSolutionPriorPass,
} from './solve';

export { QUESTION_ADMISSION_POLICY_ID } from '@/core/question-admission-policy';

/** C1 落库与迟到的 source verify 必须匹配同一个 id，含环境变量覆盖。空串是合法覆盖。 */
export function resolveQuestionAdmissionPolicyId(): string {
  const configured = process.env.QUESTION_ADMISSION_POLICY_ID;
  if (
    configured === LEGACY_QUESTION_ADMISSION_POLICY_ID ||
    configured === PREVIOUS_QUESTION_ADMISSION_POLICY_ID ||
    configured === 'question_admission@3'
  ) {
    throw new Error(
      `QUESTION_ADMISSION_POLICY_ID=${configured} is obsolete; unset it for the current admission contract`,
    );
  }
  return configured ?? QUESTION_ADMISSION_POLICY_ID;
}

export interface QuestionAdmissionOptions {
  db: Db;
  /** 缺省 makeRunTaskTextFn(db) —— 测试/编排可注入替代。 */
  runTask?: BoundRunTaskTextFn;
  subjectProfile?: SubjectProfile;
  /**
   * OPEN owner decision — solve 2 是否必须异源模型族。默认 null = 同一
   * registry 配置的模型 + 隔离上下文；给出时经 ctx.override 路由。
   */
  solver2?: { provider?: Provider; model?: string } | null;
  /** Live knowledge points offered to the solution prior (YUK-1771). */
  knowledgeCandidates?: readonly KnowledgeCandidate[];
  priorRevisionDigest?: string;
  policyId?: string;
  now?: Date;
}

export interface UnitAdmissionResult {
  scoring_unit_id: string;
  unit_kind: AdmissionUnitSpec['unit_kind'];
  status: 'admitted' | 'withheld' | 'pending';
  reason?: string;
  repair?: AdmissionRepairT;
  evidence_errors?: { which: 'source_answer' | 'printed_rule' | 'author_key'; note: string }[];
  solve?: { verdict: UnitSolveVerdict['status']; detail?: string };
  crosscheck?: 'consistent' | 'conflict' | 'unknown' | 'not_run';
  calibration?: {
    method_fingerprint: string;
    probe_digest: string;
    probes: number;
    failed: number;
    skipped: { kind: string; reason: string }[];
    results: ProbeOutcome[];
  };
}

export interface ResolvedAdmissionContract {
  structure: QuestionAdmissionDefinition['structure'];
  response_spec: QuestionAdmissionDefinition['response_spec'];
  scoring_basis: ScoringBasisT;
  execution_plan: ExecutionPlanT;
  integrity_digest: string;
}

export interface QuestionAdmissionResult {
  status: 'admitted' | 'withheld';
  decision: 'pass' | 'return_for_repair';
  reason?: string;
  per_unit: UnitAdmissionResult[];
  /** resolved 契约（resolved 单元已升级判据+规则+确定性执行器；
   * 未 resolve 单元保留原槽/判据/执行器）。 */
  resolved?: ResolvedAdmissionContract;
  /** 追加 question_admission_verification 的写包（由 publish seam 落库）。 */
  verification: {
    policy_id: string;
    outcome: 'passed' | 'suspended' | 'failed';
    evidence: Record<string, unknown>;
  };
  evidence_refs: {
    task_run_ids: string[];
    solve_receipts: AdmissionSolveReceipt[];
    crosscheck_receipt?: AdmissionSolveReceipt;
  };
  /** Solution-method prior from the dual solve; publication freezes it on the revision. */
  solution_prior?: SolutionPriorRecordT;
}

function defaultRuleFor(
  unit: AdmissionUnitSpec,
  spec: QuestionAdmissionDefinition['response_spec'],
): ScoringRuleT {
  const points = unit.points ?? 0;
  const source =
    unit.printed_rule_md != null ? { source: { statement: unit.printed_rule_md } } : {};
  if (unit.unit_kind === 'select') {
    const slot = spec.slots.find((s) => s.slot_id === unit.slot_refs[0]);
    const pick = slot?.kind === 'select' ? slot.pick : 'many';
    if (pick === 'one') {
      return {
        version: 1,
        ...source,
        cases: [{ when: { all: [{ wrong: { eq: 0 } }, { miss: { eq: 0 } }] }, award: { points } }],
        otherwise: { points: 0 },
      };
    }
    return {
      version: 1,
      ...source,
      cases: [
        { when: { wrong: { gt: 0 } }, award: { points: 0 } },
        { when: { miss: { eq: 0 } }, award: { points } },
        { when: { hit: { gt: 0 } }, award: { unknown: 'partial_points_not_printed' } },
      ],
      otherwise: { points: 0 },
    };
  }
  return {
    version: 1,
    ...source,
    cases: [{ when: { correct: { eq: 1 } }, award: { points } }],
    otherwise: { points: 0 },
  };
}

function criterionFromKey(key: AdmissionKey, unit: AdmissionUnitSpec): ScoringUnitCriterionT {
  if (key.kind === 'select') {
    return { kind: 'select_key', accepted_item_ids: key.accepted_item_ids };
  }
  if (key.kind === 'blank_text') {
    return {
      kind: 'blank_key',
      key: {
        kind: 'text',
        accepted: key.accepted,
        normalization: unit.blank_normalization ?? {
          version: 'blank-norm@1',
          nfkc: true,
          trim_outer: true,
          casefold: false,
          collapse_whitespace: true,
          ignore_punctuation: false,
          character_variants: [],
        },
      },
    };
  }
  return {
    kind: 'blank_key',
    key: {
      kind: 'numeric',
      expected: key.expected,
      tolerance: key.tolerance,
      ...(key.expected_unit != null ? { expected_unit: key.expected_unit } : {}),
    },
  };
}

function executorFor(unit: AdmissionUnitSpec): {
  kind: 'deterministic';
  comparator: 'set_compare' | 'blank_exact';
} {
  return unit.unit_kind === 'select'
    ? { kind: 'deterministic', comparator: 'set_compare' }
    : { kind: 'deterministic', comparator: 'blank_exact' };
}

export async function runQuestionAdmission(
  definition: QuestionAdmissionDefinition,
  options: QuestionAdmissionOptions,
): Promise<QuestionAdmissionResult> {
  const policyId = options.policyId ?? resolveQuestionAdmissionPolicyId();
  const now = options.now ?? new Date();
  const runTask = options.runTask ?? makeRunTaskTextFn(options.db, { judgeRetryPolicy: 'none' });
  const solverContext =
    options.solver2 != null ? 'independent_model' : 'same_model_isolated_context';
  const per_unit = new Map<string, UnitAdmissionResult>();
  const evidenceTaskRuns: AdmissionSolveReceipt[] = [];

  const unitResult = (unit: AdmissionUnitSpec): UnitAdmissionResult =>
    per_unit.get(unit.scoring_unit_id) ?? {
      scoring_unit_id: unit.scoring_unit_id,
      unit_kind: unit.unit_kind,
      status: 'pending',
    };
  const mark = (unit: AdmissionUnitSpec, patch: Partial<UnitAdmissionResult>): void => {
    per_unit.set(unit.scoring_unit_id, {
      ...unitResult(unit),
      ...patch,
      scoring_unit_id: unit.scoring_unit_id,
      unit_kind: unit.unit_kind,
    });
  };

  const structuralIssues = [
    ...validateStructure(definition.structure),
    ...validateResponseSpec(definition.response_spec),
  ];
  const emptyParts = definition.structure.parts.filter(
    (part) => part.prompt_md.trim().length === 0,
  );
  if (structuralIssues.length || emptyParts.length) {
    const reason = [
      ...structuralIssues.map((i) => i.detail),
      ...emptyParts.map((p) => `Empty prompt: ${p.part_id}`),
    ].join('; ');
    for (const unit of definition.units) mark(unit, { status: 'withheld', reason });
    return finalize(definition, policyId, now, per_unit, evidenceTaskRuns, null, solverContext, {
      status: 'withheld',
      reason,
    });
  }

  const questionText = prepareAdmissionQuestionText(
    definition,
    options.subjectProfile?.renderConfig.notation === 'katex',
  );
  if (questionText.repairs.length > 0) {
    for (const unit of definition.units) {
      const defect = questionText.repairs.find((repair) => repair.part_id === unit.part_id);
      mark(unit, {
        status: 'withheld',
        reason: defect?.repair.defect ?? 'question_text_invalid',
        ...(defect ? { repair: defect.repair } : {}),
      });
    }
    const returned = finalize(
      definition,
      policyId,
      now,
      per_unit,
      evidenceTaskRuns,
      null,
      solverContext,
      {
        status: 'withheld',
        reason: 'question_text_invalid',
      },
    );
    returned.verification.evidence.question_text = {
      markings: questionText.markings,
      changes: questionText.changes,
      repairs: questionText.repairs,
    };
    return returned;
  }
  definition = questionText.definition;

  const figureMaterials = definition.structure.materials.filter(
    (m) => isPublicSharedMaterial(m) && m.kind === 'figure',
  );
  const images: AdmissionImage[] = [];
  const assetLoader = createAssessmentAssetLoader(options.db);
  for (const material of figureMaterials) {
    const loaded = await assetLoader(material.asset, AbortSignal.timeout(15_000));
    if (
      !loaded ||
      !/^image\/(png|jpeg|gif|webp)$/.test(loaded.mime_type) ||
      `sha256:${createHash('sha256').update(loaded.bytes).digest('hex')}` !== material.asset.digest
    ) {
      for (const unit of definition.units)
        mark(unit, {
          status: 'withheld',
          reason: 'unreadable_figure',
          repair: {
            repair_target: 'figure',
            broken_part: 'figure',
            defect: 'missing_figure',
            fix_hint_md: `Supply a readable frozen image for ${material.material_id}.`,
          },
        });
      return finalize(definition, policyId, now, per_unit, evidenceTaskRuns, null, solverContext, {
        status: 'withheld',
        reason: 'unreadable_figure',
      });
    }
    images.push({
      data: Buffer.from(loaded.bytes).toString('base64'),
      mediaType: loaded.mime_type,
    });
  }

  // ---- 双盲 solve ----
  // （第 2 片）：声明 answer_shape 但未被共享比较器支持的 blank
  // 单元在付费 solve 之前扣留（enqueue/maySend 闸之外的第二层 —— 覆盖
  // submit_question 直接调用与手工 re-dispatch）；已支持声明的单元照常
  // 进入双解，比较走同一比较核心。
  const slotShapeOf = (unit: AdmissionUnitSpec) => {
    const slot = definition.response_spec.slots.find(
      (candidate) => candidate.slot_id === unit.slot_refs[0],
    );
    return slot != null && slot.kind === 'blank' && slot.answer_shape != null
      ? slot.answer_shape
      : null;
  };
  const declaredUnsupported = new Set<string>();
  for (const unit of definition.units) {
    if (unit.unit_kind !== 'blank') continue;
    const shape = slotShapeOf(unit);
    if (shape == null) continue;
    const support = declaredShapeSupport(shape);
    if (!support.supported) {
      declaredUnsupported.add(unit.scoring_unit_id);
      mark(unit, {
        status: 'withheld',
        reason: `declared_answer_shape_unsupported: ${support.reason}`,
        solve: {
          verdict: 'not_applicable',
          detail: 'declared answer_shape is not supported by the shared comparator',
        },
      });
    }
  }
  const solvableUnits = definition.units.filter(
    (unit) => unit.unit_kind !== 'unsupported' && !declaredUnsupported.has(unit.scoring_unit_id),
  );
  for (const unit of definition.units) {
    if (unit.unit_kind === 'unsupported') {
      mark(unit, {
        status: 'withheld',
        reason: 'unsupported_slot_shape',
        solve: { verdict: 'not_applicable', detail: 'slot kind has no deterministic upgrade' },
      });
    }
  }
  if (solvableUnits.length === 0) {
    return finalize(definition, policyId, now, per_unit, evidenceTaskRuns, null, solverContext, {
      status: 'withheld',
      reason: 'no_resolvable_units',
    });
  }
  let solve: Extract<Awaited<ReturnType<typeof runDualSolve>>, { ok: true }>['result'];
  {
    const outcome = await runDualSolve(options.db, definition, {
      runTask,
      images,
      subjectProfile: options.subjectProfile,
      solver2: options.solver2 ?? null,
    });
    if (!outcome.ok) {
      // Known exhausted calls return repair; their paid receipts remain in the evidence.
      evidenceTaskRuns.push(...outcome.receipts);
      return finalize(definition, policyId, now, per_unit, evidenceTaskRuns, null, solverContext, {
        status: 'withheld',
        reason: `dual solve failed before a verdict: ${outcome.error}`,
        transient: true,
      });
    }
    solve = outcome.result;
  }
  evidenceTaskRuns.push(solve.solve_a, solve.solve_b);
  for (const unit of solvableUnits) {
    const verdict = solve.verdicts.get(unit.scoring_unit_id);
    if (verdict == null) continue;
    const withheldReason =
      verdict.status === 'conflict'
        ? 'solve_conflict'
        : verdict.status === 'unsolvable'
          ? 'solve_unsolvable'
          : verdict.status === 'seed_mismatch'
            ? 'solve_seed_mismatch'
            : null;
    mark(unit, {
      solve: {
        verdict: verdict.status,
        detail: 'detail' in verdict ? verdict.detail : undefined,
      },
      ...(withheldReason != null ? { status: 'withheld' as const, reason: withheldReason } : {}),
    });
  }

  // Missing-figure references are detected before the model and force adjudication;
  // text sufficiency is a semantic decision, never guessed by a keyword allowlist.
  const publicMaterials = definition.structure.materials.filter(isPublicSharedMaterial);
  const hasFigure = publicMaterials.some((m) => m.kind === 'figure');
  const referencesFigure = definition.structure.parts.some((p) =>
    /如图|图示|见图|下图|上图|shown in (?:the )?(?:figure|diagram)/iu.test(p.prompt_md),
  );
  const figureState = hasFigure
    ? 'available'
    : referencesFigure
      ? 'missing_referenced'
      : 'none_referenced';
  let adjudicationEvidence: Awaited<ReturnType<typeof adjudicateAdmission>>['output'] | null = null;
  const freeRubrics = new Map<string, string>();
  const modelSlices = new Map<string, string>();
  const crosscheck: null = null;
  if (
    figureState !== 'none_referenced' ||
    questionText.markings.length > 0 ||
    solvableUnits.some(
      (u) =>
        solve.verdicts.get(u.scoring_unit_id)?.status !== 'agreed' || u.printed_rule_md != null,
    )
  ) {
    let adjudication: Awaited<ReturnType<typeof adjudicateAdmission>>;
    try {
      adjudication = await adjudicateAdmission(
        options.db,
        definition,
        solve,
        figureState,
        runTask,
        options.subjectProfile,
        images,
        questionText.markings,
      );
    } catch (error) {
      if (!(error instanceof AdmissionAttemptExhausted)) throw error;
      for (const unit of solvableUnits) mark(unit, { status: 'withheld', reason: error.message });
      const returned = finalize(
        definition,
        policyId,
        now,
        per_unit,
        evidenceTaskRuns,
        null,
        solverContext,
        { status: 'withheld', reason: 'adjudication_attempts_exhausted' },
      );
      returned.verification.evidence.attempt_run_ids = [
        ...solve.attempt_run_ids,
        ...error.taskRunIds,
      ];
      return returned;
    }
    adjudicationEvidence = adjudication.output;
    solve.attempt_run_ids.push(...adjudication.attempt_run_ids);
    evidenceTaskRuns.push(adjudication.receipt);
    for (const verdict of adjudication.output.per_unit) {
      const unit = definition.units.find((u) => u.scoring_unit_id === verdict.scoring_unit_id);
      if (!unit) throw new Error('Adjudication returned an unknown unit');
      mark(unit, { evidence_errors: verdict.evidence_errors });
      if (verdict.verdict === 'return_for_repair') {
        solve.verdicts.set(unit.scoring_unit_id, { status: 'conflict', detail: verdict.reason_md });
        mark(unit, { status: 'withheld', reason: verdict.reason_md, repair: verdict.repair });
      } else if (verdict.decided_key.kind === 'free') {
        freeRubrics.set(unit.scoring_unit_id, verdict.decided_key.rubric_md);
        mark(unit, { status: 'pending', reason: undefined });
      } else {
        const key = keyFromAnswer(verdict.decided_key);
        if (key == null) throw new Error('Adjudication emitted no grading key');
        const reviewed = adjudication.form_reviews.find(
          (review) => review.scoring_unit_id === unit.scoring_unit_id,
        );
        // Only the adjudicator can validate an input alias; blind overlap is not proof.
        if (reviewed) {
          if (key.kind === 'blank_text')
            key.accepted = [...new Set([...key.accepted, ...reviewed.correct])];
          const candidates = solve.probe_candidates.get(unit.scoring_unit_id) ?? {
            equivalent_forms: [],
            typical_wrong: [],
          };
          candidates.equivalent_forms.push(...reviewed.correct.map((text) => ({ text })));
          candidates.typical_wrong.push(...reviewed.incorrect);
          solve.probe_candidates.set(unit.scoring_unit_id, candidates);
        }
        solve.verdicts.set(unit.scoring_unit_id, { status: 'agreed', key });
        mark(unit, { status: 'pending', reason: undefined });
      }
    }
  }
  if (freeRubrics.size > 0) {
    const admission = await resolveModelAdmissionContext(options.db);
    const pin = admission.current_models?.get('AssessmentRuleJudgeTask');
    const slice = [...admission.slices.values()].find(
      (s) =>
        s.task_kind === 'AssessmentRuleJudgeTask' &&
        s.response_class === 'free' &&
        s.subject === options.subjectProfile?.id &&
        s.model === pin?.model &&
        s.model_version === pin?.model_version,
    );
    for (const unitId of freeRubrics.keys()) {
      if (slice) modelSlices.set(unitId, slice.slice_id);
      else {
        const unit = definition.units.find((u) => u.scoring_unit_id === unitId);
        if (!unit) throw new Error('Missing free grading unit');
        mark(unit, { status: 'withheld', reason: 'system_grading_slice_unadmitted' });
      }
    }
  }

  // ---- resolved 契约组装（两阶段：候选集先过契约校验 + 探针校准，失败的
  // 单元回退原判据/原槽位，重组最终发布契约）。 ----
  const verdictFor = (unit: AdmissionUnitSpec) => solve.verdicts.get(unit.scoring_unit_id);
  const candidateIds = new Set(
    solvableUnits
      .filter(
        (unit) =>
          unitResult(unit).status === 'pending' &&
          (verdictFor(unit)?.status === 'agreed' || modelSlices.has(unit.scoring_unit_id)),
      )
      .map((unit) => unit.scoring_unit_id),
  );
  for (const unit of solvableUnits) {
    if (candidateIds.has(unit.scoring_unit_id) && unit.points == null) {
      mark(unit, { status: 'withheld', reason: 'points_not_printed' });
      candidateIds.delete(unit.scoring_unit_id);
    }
  }

  const assemble = (resolvedIds: ReadonlySet<string>) => {
    const unresolvedSlotIds = new Set<string>();
    for (const unit of definition.units) {
      if (!resolvedIds.has(unit.scoring_unit_id)) {
        for (const slotId of unit.slot_refs) unresolvedSlotIds.add(slotId);
      }
    }
    const originalSlotById = new Map(
      (definition.original_response_spec ?? definition.response_spec).slots.map(
        (s) => [s.slot_id, s] as const,
      ),
    );
    const spec = {
      slots: definition.response_spec.slots.map((slot) =>
        unresolvedSlotIds.has(slot.slot_id) ? (originalSlotById.get(slot.slot_id) ?? slot) : slot,
      ),
    };
    const byUnitId = new Map<string, ScoringUnitT>();
    for (const unit of definition.units) {
      const verdict = verdictFor(unit);
      if (
        resolvedIds.has(unit.scoring_unit_id) &&
        (verdict?.status === 'agreed' || modelSlices.has(unit.scoring_unit_id))
      ) {
        byUnitId.set(unit.scoring_unit_id, {
          scoring_unit_id: unit.scoring_unit_id,
          slot_refs: unit.slot_refs,
          material_refs: unit.material_refs,
          evidence_slot_refs: unit.evidence_slot_refs,
          requires_group_evidence: unit.requires_group_evidence,
          criterion:
            verdict?.status === 'agreed'
              ? criterionFromKey(verdict.key, unit)
              : {
                  kind: 'rule_reference',
                  rule_id: `${unit.scoring_unit_id}::adjudicated`,
                  statement_md: freeRubrics.get(unit.scoring_unit_id) ?? '',
                  source: 'system_proposed',
                },
          points: unit.points,
          ...(unit.unit_kind === 'free'
            ? {}
            : { rule: unit.seeded_rule ?? defaultRuleFor(unit, spec) }),
        });
      }
    }
    const basis: ScoringBasisT = {
      units: definition.units.map((unit) => {
        const resolved = byUnitId.get(unit.scoring_unit_id);
        if (resolved != null) return resolved;
        const original = definition.original_units?.find(
          (u) => u.scoring_unit_id === unit.scoring_unit_id,
        );
        if (original != null) return original;
        // 新 draft 无原判据可回退：保持显式 rule_reference（不铸键），
        // 发布层如实 withhold。
        return {
          scoring_unit_id: unit.scoring_unit_id,
          slot_refs: unit.slot_refs,
          material_refs: unit.material_refs,
          evidence_slot_refs: unit.evidence_slot_refs,
          requires_group_evidence: unit.requires_group_evidence,
          criterion: unit.seeded_criterion ?? {
            kind: 'rule_reference' as const,
            rule_id: `${unit.scoring_unit_id}::unresolved`,
            statement_md: 'unresolved by admission lane — no typed key minted',
            source: 'system_proposed' as const,
          },
          points: unit.points,
        };
      }),
      aggregation: definition.aggregation,
      blank_scores_zero: definition.blank_scores_zero,
    };
    const plan: ExecutionPlanT = {
      plan_version: 1,
      assignments: definition.units.map((unit) => ({
        scoring_unit_ids: [unit.scoring_unit_id],
        executor: byUnitId.has(unit.scoring_unit_id)
          ? modelSlices.has(unit.scoring_unit_id)
            ? {
                kind: 'model_executor' as const,
                task_kind: 'AssessmentRuleJudgeTask',
                admitted_slice_id: modelSlices.get(unit.scoring_unit_id) ?? null,
                max_cost_usd_micros: Math.floor(
                  resolveTaskBudget('AssessmentRuleJudgeTask').maxCost * 1_000_000,
                ),
              }
            : executorFor(unit)
          : (definition.original_plan?.assignments.find((a) =>
              a.scoring_unit_ids.includes(unit.scoring_unit_id),
            )?.executor ??
            ({
              kind: 'model_executor',
              task_kind: 'AssessmentRuleJudgeTask',
              admitted_slice_id: null,
            } as const)),
      })),
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'pending' },
    };
    return { spec, basis, plan, byUnitId };
  };

  let assembled = assemble(candidateIds);
  const contractIssues = [
    ...validateStructure(definition.structure),
    ...validateResponseSpec(assembled.spec),
    ...validateScoringBasis(assembled.basis, assembled.spec, definition.structure),
    ...validateExecutionPlan(assembled.plan, assembled.basis).filter(
      (i) => i.code !== 'unadmitted_model_executor',
    ),
  ];
  if (contractIssues.length > 0) {
    const detail = contractIssues
      .map((i) => i.code)
      .slice(0, 5)
      .join(',');
    for (const unitId of candidateIds) {
      const unit = definition.units.find((u) => u.scoring_unit_id === unitId);
      if (unit != null) {
        mark(unit, { status: 'withheld', reason: `resolved_contract_invalid: ${detail}` });
      }
    }
    candidateIds.clear();
    assembled = assemble(candidateIds);
  }

  // ---- 冻结探针集 → evaluateSubmissionCore（与真实提交同一条判分路径） ----
  const resolvedSlotById = new Map(assembled.spec.slots.map((s) => [s.slot_id, s] as const));
  const probeRevision: PublishedQuestionRevisionT = {
    revision_id: 'admission-probe',
    group_id: definition.group_id,
    revision_ordinal: 1,
    integrity_digest: contractIntegrityDigest({
      structure: definition.structure,
      response_spec: assembled.spec,
      scoring_basis: assembled.basis,
      execution_plan: assembled.plan,
    }),
    structure: definition.structure,
    response_spec: assembled.spec,
    scoring_basis: assembled.basis,
    execution_plan: assembled.plan,
    published_at: now.toISOString(),
    supersedes_revision_id: null,
  };
  const allProbes: AdmissionProbe[] = [];
  const allSkipped: { unit: string; kind: string; reason: string }[] = [];
  const fingerprints = new Map<string, string>();
  for (const unit of definition.units) {
    if (!candidateIds.has(unit.scoring_unit_id)) continue;
    const slot: ResponseSlotT | undefined =
      unit.slot_refs[0] != null ? resolvedSlotById.get(unit.slot_refs[0]) : undefined;
    const resolved = assembled.byUnitId.get(unit.scoring_unit_id);
    const verdict = verdictFor(unit);
    if (slot == null || resolved == null || verdict?.status !== 'agreed') continue;
    fingerprints.set(
      unit.scoring_unit_id,
      methodFingerprint(resolved, slot, executorFor(unit).comparator),
    );
    const { probes, skipped } = await freezeProbes(
      resolved,
      unit,
      slot,
      verdict.key,
      { blank_scores_zero: assembled.basis.blank_scores_zero },
      solve.probe_candidates.get(unit.scoring_unit_id),
    );
    for (const s of skipped) allSkipped.push({ unit: unit.scoring_unit_id, ...s });
    allProbes.push(...probes);
  }
  const probeDigest = probeSetDigest(allProbes);
  const outcomes = await runCalibrationProbes(probeRevision, allProbes);
  const byUnit = new Map<string, ProbeOutcome[]>();
  for (const outcome of outcomes) {
    const list = byUnit.get(outcome.scoring_unit_id) ?? [];
    list.push(outcome);
    byUnit.set(outcome.scoring_unit_id, list);
  }
  for (const [unitId, results] of byUnit) {
    const unit = definition.units.find((u) => u.scoring_unit_id === unitId);
    if (unit == null) continue;
    const failed = results.filter((r) => !r.ok).length;
    mark(unit, {
      calibration: {
        method_fingerprint: fingerprints.get(unitId) ?? '',
        probe_digest: probeDigest,
        probes: results.length,
        failed,
        skipped: allSkipped.filter((s) => s.unit === unitId),
        results,
      },
      ...(failed > 0 ? { status: 'withheld' as const, reason: 'calibration_failed' } : {}),
    });
    if (failed > 0) candidateIds.delete(unitId);
  }

  // 校准/契约失败的单元不携带已铸键 —— 重组最终契约。零探针单元（组不出来
  // probe 的怪异形态）同样不准入：未标定不出。
  const finalIds = new Set(
    [...candidateIds].filter((id) => {
      const unit = definition.units.find((u) => u.scoring_unit_id === id);
      if (unit == null || unitResult(unit).status !== 'pending') return false;
      if (!modelSlices.has(id) && !(byUnit.get(id)?.length ?? 0)) {
        mark(unit, { status: 'withheld', reason: 'no_probes_executed' });
        return false;
      }
      return true;
    }),
  );
  const finalAssembled = assemble(finalIds);
  // Corrected private scoring evidence lives in the new criteria. Retain the
  // original evidence in the paid input/old revision, never feed it to the new grader.
  const resolvedMaterials =
    finalIds.size === definition.units.length
      ? definition.structure.materials.filter(isPublicSharedMaterial)
      : definition.structure.materials;
  const retainedMaterials = new Set(resolvedMaterials.map((material) => material.material_id));
  const resolvedStructure = {
    ...definition.structure,
    materials: resolvedMaterials,
    parts: definition.structure.parts.map((part) => ({
      ...part,
      material_ids: part.material_ids.filter((id) => retainedMaterials.has(id)),
    })),
  };
  const resolvedBasis = {
    ...finalAssembled.basis,
    units: finalAssembled.basis.units.map((unit) => ({
      ...unit,
      material_refs: unit.material_refs.filter((id) => retainedMaterials.has(id)),
    })),
  };
  const resolvedContract: ResolvedAdmissionContract = {
    structure: resolvedStructure,
    response_spec: finalAssembled.spec,
    scoring_basis: resolvedBasis,
    execution_plan: finalAssembled.plan,
    integrity_digest: contractIntegrityDigest({
      structure: resolvedStructure,
      response_spec: finalAssembled.spec,
      scoring_basis: resolvedBasis,
      execution_plan: finalAssembled.plan,
    }),
  };

  // ---- 聚合 ----
  for (const unit of definition.units) {
    const result = unitResult(unit);
    if (result.status === 'pending') {
      mark(
        unit,
        finalIds.has(unit.scoring_unit_id)
          ? { status: 'admitted' }
          : { status: 'withheld', reason: 'unresolved' },
      );
    }
  }
  const settledKeys = new Map<string, AdmissionKey>();
  for (const [unitId, verdict] of solve.verdicts) {
    if (verdict.status === 'agreed') settledKeys.set(unitId, verdict.key);
  }
  // No settled key means the solvers could not agree on the answer, so a description of
  // the solution (and a write-once difficulty anchor from it) would be speculation.
  const prior: SolutionPriorPassResult =
    (settledKeys.size === 0 && freeRubrics.size === 0) ||
    options.priorRevisionDigest === resolvedContract.integrity_digest ||
    !definition.units.every((unit) => unitResult(unit).status === 'admitted')
      ? {
          record: null,
          receipt: null,
          outcome: { status: 'skipped', task_run_id: null, reason: 'no settled key' },
        }
      : await runSolutionPriorPass(options.db, definition, settledKeys, {
          runTask,
          freeRubrics,
          images,
          ...(options.subjectProfile != null ? { subjectProfile: options.subjectProfile } : {}),
          ...(options.knowledgeCandidates != null
            ? { knowledgeCandidates: options.knowledgeCandidates }
            : {}),
        });
  if (prior.receipt != null) evidenceTaskRuns.push(prior.receipt);
  const allAdmitted = definition.units.every((unit) => unitResult(unit).status === 'admitted');
  const result = finalize(
    definition,
    policyId,
    now,
    per_unit,
    evidenceTaskRuns,
    crosscheck,
    solverContext,
    {
      status: allAdmitted ? 'admitted' : 'withheld',
      ...(allAdmitted ? {} : { reason: 'unit_level_withhold' }),
      resolved: resolvedContract,
    },
  );
  result.verification.evidence.figure_state = figureState;
  result.verification.evidence.question_text = {
    markings: questionText.markings,
    changes: questionText.changes,
  };
  result.verification.evidence.adjudication = adjudicationEvidence;
  result.verification.evidence.blind_solves = solve.outputs;
  result.verification.evidence.attempt_run_ids = solve.attempt_run_ids;
  result.verification.evidence.solution_prior_pass = prior.outcome;
  return prior.record != null ? { ...result, solution_prior: prior.record } : result;
}

function finalize(
  definition: QuestionAdmissionDefinition,
  policyId: string,
  now: Date,
  per_unit: Map<string, UnitAdmissionResult>,
  evidenceTaskRuns: AdmissionSolveReceipt[],
  _crosscheck: null,
  solverContext: string,
  tail: {
    status: 'admitted' | 'withheld';
    reason?: string;
    resolved?: ResolvedAdmissionContract;
    transient?: boolean;
  },
): QuestionAdmissionResult {
  const units = definition.units.map((unit) => {
    const result = per_unit.get(unit.scoring_unit_id) ?? {
      scoring_unit_id: unit.scoring_unit_id,
      unit_kind: unit.unit_kind,
      status: 'withheld' as const,
      reason: tail.reason ?? 'unresolved',
    };
    if (tail.status !== 'admitted' && result.status === 'pending') result.status = 'withheld';

    return result;
  });
  const outcome = tail.status === 'admitted' ? 'passed' : 'failed';
  const evidence: Record<string, unknown> = {
    pack: 'question_admission',
    pack_version: 1,
    policy_id: policyId,
    definition_digest: canonicalHash({
      structure: definition.structure,
      response_spec: definition.response_spec,
      units: definition.units.map((u) => ({
        scoring_unit_id: u.scoring_unit_id,
        unit_kind: u.unit_kind,
        slot_refs: u.slot_refs,
        points: u.points,
        seeded: u.seeded_criterion != null,
      })),
      source_answer_count: definition.source_answers.length,
    }),
    base_contract_digest: definition.base_contract_digest,
    /** 如实记录 solver 拓扑：未配置 solver2 = 同模型独立上下文（非异源）。 */
    solver_context: solverContext,
    /** Successful task receipts; attempt_run_ids also includes failed paid attempts. */
    task_runs: evidenceTaskRuns.map((receipt) => ({
      task_run_id: receipt.task_run_id,
      provider: receipt.provider,
      model: receipt.model,
      input_digest: receipt.input_digest,
      output_digest: receipt.output_digest,
      cost_usd: receipt.cost_usd,
    })),
    crosscheck: { ran: false, replaced_by: 'adjudication' },
    per_unit: units,
    ...(tail.transient === true ? { transient: true } : {}),
    recorded_at: now.toISOString(),
  };
  return {
    status: tail.status,
    decision: tail.status === 'admitted' ? 'pass' : 'return_for_repair',
    ...(tail.reason != null ? { reason: tail.reason } : {}),
    per_unit: units,
    ...(tail.resolved != null ? { resolved: tail.resolved } : {}),
    verification: { policy_id: policyId, outcome, evidence },
    evidence_refs: {
      task_run_ids: evidenceTaskRuns.map((r) => r.task_run_id),
      solve_receipts: evidenceTaskRuns,
    },
  };
}
