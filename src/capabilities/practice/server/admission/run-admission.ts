// YUK-1445 (Stage 1 / G1+G2) — runQuestionAdmission.
//
// The single admission call site B1's `submit_question` wires; today the live
// consumer is the `question_admission_run` worker job. Given a frozen draft
// definition (four contract layers + per-unit scoring intent):
//
//   1. dual blind solve mints typed keys (no reference text parsing);
//   2. printed source answers are cross-checked, never parsed into keys;
//   3. every resolvable unit gets a frozen probe set executed through the same
//      evaluateSubmissionCore real submissions use;
//   4. any disagreeing solve / crosscheck conflict-or-unknown / failing probe
//      / non-deterministic unit blocks admission — fail closed, never mint.
//
// Evidence returns with the result; persistence (question_admission_verification
// append + lifecycle admission flip) is the caller's publish seam.

import { canonicalHash } from '@/core/migration/canonical';
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
import { contractIntegrityDigest } from '@/kernel/records/assessment-normalization';
import type { SubjectProfile } from '@/subjects/profile';
import { type PracticeTaskRunFn, makePracticeTaskTextRunFn } from '../task-runtime';
import {
  type AdmissionProbe,
  type ProbeOutcome,
  freezeProbes,
  methodFingerprint,
  probeSetDigest,
  runCalibrationProbes,
} from './calibrate';
import type { AdmissionUnitSpec, QuestionAdmissionDefinition } from './contract';
import {
  type AdmissionKey,
  type AdmissionSolveReceipt,
  type Provider,
  type SourceCrosscheckResult,
  type UnitSolveVerdict,
  runDualSolve,
  runSourceCrosscheck,
} from './solve';

export const QUESTION_ADMISSION_POLICY_ID = 'question_admission@1';

/** C1 落库与迟到的 source verify 必须匹配同一个 id，含环境变量覆盖。空串是合法覆盖。 */
export function resolveQuestionAdmissionPolicyId(): string {
  return process.env.QUESTION_ADMISSION_POLICY_ID ?? QUESTION_ADMISSION_POLICY_ID;
}

export interface QuestionAdmissionOptions {
  db: Db;
  /** 缺省 makePracticeTaskTextRunFn(db) —— 测试/编排可注入替代。 */
  runTask?: PracticeTaskRunFn;
  subjectProfile?: SubjectProfile;
  /**
   * OPEN owner decision — solve 2 是否必须异源模型族。默认 null = 同一
   * registry 配置的模型 + 隔离上下文；给出时经 ctx.override 路由。
   */
  solver2?: { provider?: Provider; model?: string } | null;
  policyId?: string;
  now?: Date;
}

export interface UnitAdmissionResult {
  scoring_unit_id: string;
  unit_kind: AdmissionUnitSpec['unit_kind'];
  status: 'admitted' | 'withheld' | 'pending';
  reason?: string;
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
  status: 'admitted' | 'withheld' | 'pending';
  reason?: string;
  per_unit: UnitAdmissionResult[];
  /** resolved 契约（resolved 单元已升级判据+规则+确定性执行器；
   *  未 resolve 单元保留原槽/判据/执行器）。 */
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
  const policyId = options.policyId ?? QUESTION_ADMISSION_POLICY_ID;
  const now = options.now ?? new Date();
  const runTask = options.runTask ?? makePracticeTaskTextRunFn(options.db);
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

  // ---- 双盲 solve ----
  const solvableUnits = definition.units.filter(
    (unit) => unit.unit_kind === 'select' || unit.unit_kind === 'blank',
  );
  for (const unit of definition.units) {
    if (unit.unit_kind === 'unsupported') {
      mark(unit, {
        status: 'withheld',
        reason: 'unsupported_slot_shape',
        solve: { verdict: 'not_applicable', detail: 'slot kind has no deterministic upgrade' },
      });
    } else if (unit.unit_kind === 'free') {
      mark(unit, {
        status: 'withheld',
        reason: 'no_admitted_executor',
        solve: { verdict: 'not_applicable', detail: 'free unit needs an admitted model executor' },
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
      subjectProfile: options.subjectProfile,
      solver2: options.solver2 ?? null,
    });
    if (!outcome.ok) {
      // infra / receipt 密封失败 —— 如实 pending，不伪判、不铸键；已付费的
      // solve 收据照样进证据包。
      evidenceTaskRuns.push(...outcome.receipts);
      return finalize(definition, policyId, now, per_unit, evidenceTaskRuns, null, solverContext, {
        status: 'pending',
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

  // ---- source crosscheck（仅 evidence；conflict/unknown 阻断） ----
  let crosscheck: SourceCrosscheckResult | null = null;
  const agreedKeys = new Map<string, AdmissionKey>();
  for (const unit of solvableUnits) {
    const verdict = solve.verdicts.get(unit.scoring_unit_id);
    if (verdict?.status === 'agreed') agreedKeys.set(unit.scoring_unit_id, verdict.key);
  }
  if (agreedKeys.size > 0 && definition.source_answers.length > 0) {
    try {
      const xc = await runSourceCrosscheck(options.db, definition, agreedKeys, {
        runTask,
        subjectProfile: options.subjectProfile,
      });
      crosscheck = xc;
      if (xc == null) {
        for (const unit of solvableUnits) {
          if (agreedKeys.has(unit.scoring_unit_id)) mark(unit, { crosscheck: 'not_run' });
        }
      } else {
        evidenceTaskRuns.push(xc.receipt);
        for (const unit of solvableUnits) {
          const entry = xc.per_unit.get(unit.scoring_unit_id);
          if (entry == null) {
            mark(unit, {
              crosscheck: 'unknown',
              status: 'withheld',
              reason: 'crosscheck_missing_unit',
            });
            continue;
          }
          mark(unit, { crosscheck: entry.status });
          if (entry.status !== 'consistent') {
            mark(unit, {
              status: 'withheld',
              reason: `source_crosscheck_${entry.status}${entry.reason_md ? `: ${entry.reason_md}` : ''}`,
            });
          }
        }
      }
    } catch (error) {
      return finalize(
        definition,
        policyId,
        now,
        per_unit,
        evidenceTaskRuns,
        crosscheck,
        solverContext,
        {
          status: 'pending',
          reason: `source crosscheck failed before a verdict: ${error instanceof Error ? error.message : String(error)}`,
          transient: true,
        },
      );
    }
  }

  // ---- resolved 契约组装（两阶段：候选集先过契约校验 + 探针校准，失败的
  //      单元回退原判据/原槽位，重组最终发布契约）。 ----
  const verdictFor = (unit: AdmissionUnitSpec) => solve.verdicts.get(unit.scoring_unit_id);
  const candidateIds = new Set(
    solvableUnits
      .filter(
        (unit) => unitResult(unit).status === 'pending' && verdictFor(unit)?.status === 'agreed',
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
      if (resolvedIds.has(unit.scoring_unit_id) && verdict?.status === 'agreed') {
        byUnitId.set(unit.scoring_unit_id, {
          scoring_unit_id: unit.scoring_unit_id,
          slot_refs: unit.slot_refs,
          material_refs: unit.material_refs,
          evidence_slot_refs: unit.evidence_slot_refs,
          requires_group_evidence: unit.requires_group_evidence,
          criterion: unit.seeded_criterion ?? criterionFromKey(verdict.key, unit),
          points: unit.points,
          rule: unit.seeded_rule ?? defaultRuleFor(unit, spec),
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
          ? executorFor(unit)
          : (definition.original_plan?.assignments.find((a) =>
              a.scoring_unit_ids.includes(unit.scoring_unit_id),
            )?.executor ?? ({ kind: 'human_review' } as const)),
      })),
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
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
    const { probes, skipped } = freezeProbes(
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
      if (!(byUnit.get(id)?.length ?? 0)) {
        mark(unit, { status: 'withheld', reason: 'no_probes_executed' });
        return false;
      }
      return true;
    }),
  );
  const finalAssembled = assemble(finalIds);
  const resolvedContract: ResolvedAdmissionContract = {
    structure: definition.structure,
    response_spec: finalAssembled.spec,
    scoring_basis: finalAssembled.basis,
    execution_plan: finalAssembled.plan,
    integrity_digest: contractIntegrityDigest({
      structure: definition.structure,
      response_spec: finalAssembled.spec,
      scoring_basis: finalAssembled.basis,
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
  const allAdmitted = definition.units.every((unit) => unitResult(unit).status === 'admitted');
  return finalize(
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
}

function finalize(
  definition: QuestionAdmissionDefinition,
  policyId: string,
  now: Date,
  per_unit: Map<string, UnitAdmissionResult>,
  evidenceTaskRuns: AdmissionSolveReceipt[],
  crosscheck: SourceCrosscheckResult | null,
  solverContext: string,
  tail: {
    status: 'admitted' | 'withheld' | 'pending';
    reason?: string;
    resolved?: ResolvedAdmissionContract;
    transient?: boolean;
  },
): QuestionAdmissionResult {
  const units = [...per_unit.values()];
  const outcome =
    tail.status === 'admitted' ? 'passed' : tail.status === 'pending' ? 'suspended' : 'failed';
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
    /** 本次 admission 实际发生的全部 task runs（solve×2 + crosscheck?）。 */
    task_runs: evidenceTaskRuns.map((receipt) => ({
      task_run_id: receipt.task_run_id,
      provider: receipt.provider,
      model: receipt.model,
      input_digest: receipt.input_digest,
      output_digest: receipt.output_digest,
      cost_usd: receipt.cost_usd,
    })),
    crosscheck:
      crosscheck == null
        ? { ran: false }
        : {
            ran: true,
            task_run_id: crosscheck.receipt.task_run_id,
            per_unit: Object.fromEntries(
              [...crosscheck.per_unit.entries()].map(([k, v]) => [k, v.status]),
            ),
          },
    per_unit: units,
    ...(tail.transient === true ? { transient: true } : {}),
    recorded_at: now.toISOString(),
  };
  return {
    status: tail.status,
    ...(tail.reason != null ? { reason: tail.reason } : {}),
    per_unit: units,
    ...(tail.resolved != null ? { resolved: tail.resolved } : {}),
    verification: { policy_id: policyId, outcome, evidence },
    evidence_refs: {
      task_run_ids: evidenceTaskRuns.map((r) => r.task_run_id),
      solve_receipts: evidenceTaskRuns,
      ...(crosscheck != null ? { crosscheck_receipt: crosscheck.receipt } : {}),
    },
  };
}
