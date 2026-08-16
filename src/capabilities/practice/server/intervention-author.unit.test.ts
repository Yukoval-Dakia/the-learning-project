import { describe, expect, it, vi } from 'vitest';
import {
  CurrentInterventionPackageReviewAudit,
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
  InterventionAuthoringContext,
  InterventionIndependentSolutionAudit,
  InterventionPackage,
  InterventionPackageReviewAudit,
  type InterventionPackageReviewDiagnosticCheckT,
  InterventionPackageReviewModelOutput,
  InterventionPackageReviewStructuredOutput,
  type InterventionPackageReviewStructuredOutputT,
  InterventionQuestionContentValidationAudit,
  MAX_INTERVENTION_PREPARATION_CALLS_PER_DELIVERY,
  MAX_INTERVENTION_REVIEW_EVAL_CALLS_PER_CASE,
  MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE,
  buildInterventionPackageReviewTaskInput,
  buildInterventionQuestionContentValidationTaskInput,
  extractInterventionReferenceReverseCausationClaims,
  interventionPackageReviewRequirements,
  interventionRequiredOperationDigest,
} from '@/core/schema/intervention';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import interventionRegressionFixture from '@/server/grounding-gate/fixtures/intervention-review-regressions.v1.json' with {
  type: 'json',
};
import { resolveSubjectProfile } from '@/subjects/profile';
import {
  bindInterventionPackageReviewDecision,
  enforceInterventionPackageReviewDecision,
  normalizeInterventionPackageModelOutput,
  reviewInterventionPackageCandidate,
} from './intervention-author';

function passingPackageChecks() {
  return {
    material_grounded: true,
    method_followed: true,
    tested_claims_match: true,
    target_errors_match: true,
    answers_unique: true,
    answers_gradable: true,
    no_answer_leak: true,
    diagnostics_same_construct: true,
    transfer_context_changed: true,
    target_error_identifiable: true,
    serious_factual_error_absent: true,
    safe_material: true,
  };
}

const CLAIM = '学习者把外层导数和内层导数相加。';
const TARGET_ERROR = '把外层导数与内层导数相加，而不是相乘。';

function probeSpec(prompt: string) {
  return {
    schema_version: 2,
    prompt_md: prompt,
    reference_md: '2x cos(x²)',
    expected_target_error_answer_md: 'cos(x²)+2x',
    elicits_target_error_reason_md: '区分相乘与相加。',
    context_kind: 'abstract',
    representation_kind: 'symbolic',
    response_mode: 'short_answer',
    gold_response_signature: { kind: 'text', response_md: '2x cos(x²)' },
    target_error_response_signature: { kind: 'text', response_md: 'cos(x²)+2x' },
  };
}

describe('normalizeInterventionPackageModelOutput', () => {
  it('freezes diagnostic identities and moves transfer context_change_md out of probe_spec', () => {
    const output = {
      schema_version: 1,
      material: { title_md: '链式法则', body_md: '外层导数乘以内层导数。' },
      diagnostics: {
        immediate: {
          kind: 'immediate',
          probe_spec: probeSpec('立即题'),
          tested_claim_md: '模型改写的 claim',
          target_error_rule_md: '模型改写的规则',
        },
        delayed: {
          kind: 'delayed',
          probe_spec: probeSpec('延迟题'),
          tested_claim_md: '模型改写的 claim',
          target_error_rule_md: '模型改写的规则',
        },
        transfer: {
          kind: 'transfer',
          probe_spec: {
            ...probeSpec('迁移题'),
            context_kind: 'applied',
            representation_kind: 'natural_language',
            context_change_md: '从纯符号函数换到热膨胀情境。',
          },
        },
      },
    };

    const normalized = normalizeInterventionPackageModelOutput(output, {
      testedClaimMd: CLAIM,
      targetErrorRuleMd: TARGET_ERROR,
    });

    expect(normalized.diagnostics.immediate).toMatchObject({
      kind: 'immediate',
      tested_claim_md: CLAIM,
      target_error_rule_md: TARGET_ERROR,
    });
    expect(normalized.diagnostics.delayed).toMatchObject({
      kind: 'delayed',
      tested_claim_md: CLAIM,
      target_error_rule_md: TARGET_ERROR,
    });
    expect(normalized.diagnostics.transfer).toMatchObject({
      kind: 'transfer',
      tested_claim_md: CLAIM,
      target_error_rule_md: TARGET_ERROR,
      context_change_md: '从纯符号函数换到热膨胀情境。',
    });
    expect(normalized.diagnostics.transfer.probe_spec).not.toHaveProperty('context_change_md');

    const misplacedImmediate = structuredClone(output);
    Object.assign(misplacedImmediate.diagnostics.immediate.probe_spec, {
      context_change_md: '不应被静默剥离',
    });
    expect(() =>
      normalizeInterventionPackageModelOutput(misplacedImmediate, {
        testedClaimMd: CLAIM,
        targetErrorRuleMd: TARGET_ERROR,
      }),
    ).toThrow();
  });

  it('rejects a mismatched diagnostic kind instead of masking a possible content swap', () => {
    const output = {
      schema_version: 1,
      material: { title_md: '链式法则', body_md: '外层导数乘以内层导数。' },
      diagnostics: {
        immediate: {
          kind: 'delayed',
          probe_spec: probeSpec('立即题'),
          tested_claim_md: CLAIM,
          target_error_rule_md: TARGET_ERROR,
        },
        delayed: {
          kind: 'delayed',
          probe_spec: probeSpec('延迟题'),
          tested_claim_md: CLAIM,
          target_error_rule_md: TARGET_ERROR,
        },
        transfer: {
          kind: 'transfer',
          probe_spec: {
            ...probeSpec('迁移题'),
            context_kind: 'applied',
            representation_kind: 'natural_language',
          },
          tested_claim_md: CLAIM,
          target_error_rule_md: TARGET_ERROR,
          context_change_md: '从纯符号函数换到热膨胀情境。',
        },
      },
    };

    expect(() =>
      normalizeInterventionPackageModelOutput(output, {
        testedClaimMd: CLAIM,
        targetErrorRuleMd: TARGET_ERROR,
      }),
    ).toThrow();
  });
});

describe('bindInterventionPackageReviewDecision — sealed FULL comparator', () => {
  function audit(caseIndex = 0) {
    const fixture = interventionRegressionFixture.cases[caseIndex];
    if (!fixture) throw new Error('missing complex area regression fixture');
    return InterventionIndependentSolutionAudit.parse({
      validation_protocol_version: 1,
      package_digest_sha256: sha256CanonicalJson(fixture.package),
      diagnostics: (['immediate', 'delayed', 'transfer'] as const).map((kind, index) => {
        const diagnostic = fixture.package.diagnostics[kind];
        const taskInput = {
          prompt_md: diagnostic.probe_spec.prompt_md,
          kind: diagnostic.probe_spec.response_mode,
          subject_id: fixture.subject_id,
          choices_md: [],
          existing_answers_hint: null,
          existing_analysis_hint: null,
          figures_hint: null,
          prompt_image_refs: [],
        };
        const solverOutput = {
          reference_solution: {
            expected_signals:
              kind === 'transfer'
                ? ['先由面积=长×宽建立 -5(w-4)²', '再展开二次式并检查平方米量纲']
                : ['把负因子分配到括号内每一项', '负数乘负数得到正数'],
            final_answer:
              kind === 'transfer' ? '-5(w-4)² = -5w²+40w-80 平方米' : `independent-${kind}`,
            answer_equivalents: [],
          },
          worked_solution_md:
            kind === 'transfer'
              ? '长度是 -5(w-4)，宽是 (w-4)，面积必须把两者相乘。'
              : '逐项分配负因子并检查符号。',
          confidence: 0.97,
        };
        return {
          kind,
          task_input: taskInput,
          question_input_sha256: sha256CanonicalJson(taskInput),
          solver_output: solverOutput,
          solver_output_sha256: sha256CanonicalJson(solverOutput),
          solver_output_repair_level: false,
          solver_task_run_id: `blind-${index + 1}`,
          solver_attempt_task_run_ids: [`blind-${index + 1}`],
          independently_derived_answer_md: solverOutput.reference_solution.final_answer,
          required_operations_md: solverOutput.reference_solution.expected_signals.join('；'),
          required_operations: solverOutput.reference_solution.expected_signals.map(
            (operationMd, operationIndex) => ({
              operation_index: operationIndex,
              operation_sha256: interventionRequiredOperationDigest(operationMd),
              operation_md: operationMd,
            }),
          ),
        };
      }),
    });
  }

  function contentAudit(caseIndex = 0) {
    const fixture = interventionRegressionFixture.cases[caseIndex];
    if (!fixture) throw new Error('missing complex regression fixture');
    const context = InterventionAuthoringContext.parse(fixture.context);
    const packageValue = InterventionPackage.parse(fixture.package);
    return InterventionQuestionContentValidationAudit.parse({
      validation_protocol_version: 1,
      package_digest_sha256: sha256CanonicalJson(packageValue),
      diagnostics: (['immediate', 'delayed', 'transfer'] as const).map((kind, index) => {
        const taskInput = buildInterventionQuestionContentValidationTaskInput({
          context,
          packageValue,
          kind,
          subjectId: fixture.subject_id,
        });
        const result = {
          grounding: { verdict: 'pass' as const, note: '题面与参考答案有独立学科依据。' },
          copy_safety: { verdict: 'original' as const, max_overlap: 0.08 },
          knowledge_hit: { verdict: 'pass' as const, note: '命中冻结知识构念。' },
          overall: 'pass' as const,
          summary_md: '严格题目内容核验通过。',
          confidence: 0.96,
        };
        return {
          kind,
          task_input: taskInput,
          task_input_sha256: sha256CanonicalJson(taskInput),
          result,
          result_sha256: sha256CanonicalJson(result),
          output_repair_level: false,
          task_run_id: `content-${index + 1}`,
        };
      }),
    });
  }

  function bindOutput(
    output: unknown,
    independentAudit = audit(),
    caseIndex = 0,
    requirements = {
      audit_entire_solution_path: true as const,
      causal_direction_required: false,
    },
  ) {
    const fixture = interventionRegressionFixture.cases[caseIndex];
    if (!fixture) throw new Error('missing complex regression fixture');
    return bindInterventionPackageReviewDecision(
      output,
      independentAudit,
      contentAudit(caseIndex),
      requirements,
      InterventionPackage.parse(fixture.package),
    );
  }

  function comparatorOutput(independentAudit = audit()) {
    return {
      review_protocol_version: 2 as const,
      verdict: 'pass' as const,
      failure_codes: [],
      diagnostic_checks: independentAudit.diagnostics.map((diagnostic) => ({
        kind: diagnostic.kind,
        required_operation_checks: diagnostic.required_operations.map((operation) => ({
          operation_index: operation.operation_index,
          reference_covers_operation: true,
          within_frozen_scope: true,
          decision_basis_md: 'reference 覆盖该步骤，且该步骤位于冻结范围内。',
        })),
        reference_correct: true,
        within_frozen_scope: true,
        discipline_grounded: true,
        decision_basis_md: '密封盲解与 reference、冻结范围和学科事实一致。',
        causal_direction_check: {
          applies: false,
          exposure_x_md: '',
          observed_outcome_y_md: '',
          reference_reverse_causation_claim_relations: [],
        },
      })),
      package_checks: passingPackageChecks(),
      summary_md: '密封盲解和包级检查全部通过。',
    };
  }

  it('server-binds all provenance and rejects a reordered required operation', () => {
    const independentAudit = audit();
    const bound = bindOutput(comparatorOutput(independentAudit), independentAudit);
    expect(bound.verdict).toBe('pass');
    expect(bound.diagnostic_checks[2]).toMatchObject({
      kind: 'transfer',
      independent_solution_sha256: independentAudit.diagnostics[2]?.solver_output_sha256,
      independently_derived_answer_md: '-5(w-4)² = -5w²+40w-80 平方米',
      required_operations_md: expect.stringContaining('面积=长×宽'),
      required_operation_checks: [
        expect.objectContaining({
          operation_index: 0,
          operation_sha256:
            independentAudit.diagnostics[2]?.required_operations[0]?.operation_sha256,
          operation_md: expect.stringContaining('面积=长×宽'),
        }),
        expect.objectContaining({ operation_index: 1 }),
      ],
    });

    const mismatched = comparatorOutput(independentAudit);
    if (!mismatched.diagnostic_checks[2]) throw new Error('missing transfer check');
    if (!mismatched.diagnostic_checks[2].required_operation_checks[0]) {
      throw new Error('missing transfer operation check');
    }
    mismatched.diagnostic_checks[2].required_operation_checks[0].operation_index = 1;
    expect(() => bindOutput(mismatched, independentAudit)).toThrow('wrong sealed operation');

    const missingOperation = comparatorOutput(independentAudit);
    missingOperation.diagnostic_checks[2]?.required_operation_checks.pop();
    expect(() => bindOutput(missingOperation, independentAudit)).toThrow(
      'omitted required solution operations',
    );
  });

  it('maps a contradictory package-level bare pass to a bounded fail code', () => {
    const independentAudit = audit();
    const output = comparatorOutput(independentAudit) as InterventionPackageReviewStructuredOutputT;
    output.package_checks.material_grounded = false;
    const bound = bindOutput(output, independentAudit);
    expect(bound).toMatchObject({
      verdict: 'fail',
      failure_codes: ['material_not_grounded'],
    });
  });

  it('lets release-strict grounding veto a polished comparator pass on a named-work false gloss', () => {
    const independentAudit = audit(1);
    const fixture = interventionRegressionFixture.cases[1];
    if (!fixture) throw new Error('missing complex yuwen false-gloss fixture');
    const rawContentAudit = structuredClone(contentAudit(1));
    const immediate = rawContentAudit.diagnostics.find(
      (diagnostic) => diagnostic.kind === 'immediate',
    );
    if (!immediate) throw new Error('missing immediate content-validation audit');
    immediate.result = {
      ...immediate.result,
      grounding: {
        verdict: 'fail',
        note: '《卜算子·咏梅》并无题面所称固定原句，作者材料不是独立事实来源。',
      },
      overall: 'fail',
      summary_md: '题目命中论证构念，但具名作品的引文和语义方向不成立。',
    };
    immediate.result_sha256 = sha256CanonicalJson(immediate.result);
    const strictContentAudit = InterventionQuestionContentValidationAudit.parse(rawContentAudit);

    const bound = bindInterventionPackageReviewDecision(
      comparatorOutput(independentAudit),
      independentAudit,
      strictContentAudit,
      { audit_entire_solution_path: true, causal_direction_required: false },
      InterventionPackage.parse(fixture.package),
    );

    expect(bound).toMatchObject({
      verdict: 'fail',
      failure_codes: ['reference_incorrect'],
      diagnostic_checks: [
        expect.objectContaining({ kind: 'immediate', discipline_grounded: false }),
        expect.objectContaining({ kind: 'delayed', discipline_grounded: true }),
        expect.objectContaining({ kind: 'transfer', discipline_grounded: true }),
      ],
    });
  });

  it('derives the closed verdict even when provider advisory labels are omitted or contradictory', () => {
    const independentAudit = audit();
    const {
      verdict: _providerVerdict,
      failure_codes: _providerFailureCodes,
      ...withoutAdvice
    } = comparatorOutput(independentAudit);
    expect(bindOutput(withoutAdvice, independentAudit)).toMatchObject({
      verdict: 'pass',
      failure_codes: [],
    });

    const contradictoryAdvice = comparatorOutput(independentAudit) as Record<string, unknown>;
    contradictoryAdvice.verdict = 'fail';
    contradictoryAdvice.failure_codes = ['provider_invented_unbound_label'];
    const failClosed = bindOutput(contradictoryAdvice, independentAudit);
    expect(failClosed).toMatchObject({
      verdict: 'fail',
      failure_codes: ['review_output_invalid'],
    });
    expect(failClosed.failure_codes).not.toContain('provider_invented_unbound_label');
  });

  it('accepts a 2000-character audit summary and rejects 2001 characters', () => {
    const independentAudit = audit();
    const boundary = comparatorOutput(independentAudit);
    boundary.summary_md = '核'.repeat(2000);
    expect(InterventionPackageReviewStructuredOutput.safeParse(boundary).success).toBe(true);
    boundary.summary_md = '核'.repeat(2001);
    expect(InterventionPackageReviewStructuredOutput.safeParse(boundary).success).toBe(false);
  });

  it('derives causal review requirements only from the frozen conjecture and forbids applies=false', () => {
    const causalFixture = interventionRegressionFixture.cases[2];
    const mathFixture = interventionRegressionFixture.cases[3];
    const yuwenFixture = interventionRegressionFixture.cases[4];
    if (!causalFixture || !mathFixture || !yuwenFixture) throw new Error('missing regressions');

    expect(
      interventionPackageReviewRequirements(
        InterventionAuthoringContext.parse(causalFixture.context),
      ),
    ).toEqual({ audit_entire_solution_path: true, causal_direction_required: true });
    for (const fixture of [mathFixture, yuwenFixture]) {
      expect(
        interventionPackageReviewRequirements(InterventionAuthoringContext.parse(fixture.context)),
      ).toEqual({ audit_entire_solution_path: true, causal_direction_required: false });
    }

    const mislabeledCauses = structuredClone(mathFixture.context);
    mislabeledCauses.snapshot.conjecture.claim_md = '你把同时出现当成甲导致乙的充分证据。';
    expect(
      interventionPackageReviewRequirements(InterventionAuthoringContext.parse(mislabeledCauses)),
    ).toEqual({ audit_entire_solution_path: true, causal_direction_required: true });

    const legacyWithoutExplicitType = structuredClone(mathFixture.context);
    const { causal_direction_required: _causal, ...legacyDiagnosticSpec } =
      legacyWithoutExplicitType.snapshot.conjecture.diagnostic_spec;
    legacyWithoutExplicitType.snapshot.conjecture.diagnostic_spec = {
      ...legacyDiagnosticSpec,
      schema_version: 1,
    } as never;
    expect(
      interventionPackageReviewRequirements(
        InterventionAuthoringContext.parse(legacyWithoutExplicitType),
      ),
    ).toEqual({ audit_entire_solution_path: true, causal_direction_required: true });

    const independentAudit = audit(2);
    const context = InterventionAuthoringContext.parse(causalFixture.context);
    const reviewInput = buildInterventionPackageReviewTaskInput({
      context,
      packageValue: InterventionPackage.parse(causalFixture.package),
      independentAudit,
      questionContentValidationAudit: contentAudit(2),
    });
    expect(reviewInput.review_requirements.causal_direction_required).toBe(true);
    expect(() =>
      bindInterventionPackageReviewDecision(
        comparatorOutput(independentAudit),
        independentAudit,
        contentAudit(2),
        reviewInput.review_requirements,
        InterventionPackage.parse(causalFixture.package),
      ),
    ).toThrow('omitted required causal-direction review');
  });

  it('rejects provider-authored solver and operation digests', () => {
    const independentAudit = audit();
    const solverDigest = structuredClone(comparatorOutput(independentAudit));
    Object.assign(solverDigest.diagnostic_checks[0] ?? {}, {
      independent_solution_sha256: 'a'.repeat(64),
    });
    expect(InterventionPackageReviewStructuredOutput.safeParse(solverDigest).success).toBe(false);

    const operationDigest = structuredClone(comparatorOutput(independentAudit));
    Object.assign(operationDigest.diagnostic_checks[0]?.required_operation_checks[0] ?? {}, {
      operation_sha256: 'b'.repeat(64),
    });
    expect(InterventionPackageReviewStructuredOutput.safeParse(operationDigest).success).toBe(
      false,
    );
  });

  it('derives Y→X from the claimed cause relation instead of trusting a provider boolean', () => {
    const independentAudit = audit(2);
    const packageValue = InterventionPackage.parse(interventionRegressionFixture.cases[2]?.package);
    const output = comparatorOutput(independentAudit) as InterventionPackageReviewStructuredOutputT;
    for (const check of output.diagnostic_checks) {
      check.causal_direction_check = {
        applies: true,
        exposure_x_md: 'treatment X',
        observed_outcome_y_md: '暴露后实际观察的 outcome Y',
        reference_reverse_causation_claim_relations:
          extractInterventionReferenceReverseCausationClaims(packageValue, check.kind).map(
            (claim) => ({
              claim_index: claim.claim_index,
              relation: 'same_outcome_construct_y' as const,
              decision_basis_md: '该主张使用题面同一个 outcome 构念。',
            }),
          ),
      };
    }
    const delayed = output.diagnostic_checks.find((check) => check.kind === 'delayed');
    if (!delayed) throw new Error('missing delayed comparator check');
    delayed.causal_direction_check = {
      applies: true,
      exposure_x_md: '参加补习',
      observed_outcome_y_md: '期末成绩提高幅度',
      reference_reverse_causation_claim_relations:
        extractInterventionReferenceReverseCausationClaims(packageValue, 'delayed').map(
          (claim) => ({
            claim_index: claim.claim_index,
            relation: 'baseline_or_prior_different_construct' as const,
            decision_basis_md: '题面 Y 是提高幅度，基线成绩与学习倾向不是同一 ΔY。',
          }),
        ),
    };

    const bound = bindInterventionPackageReviewDecision(
      output,
      independentAudit,
      contentAudit(2),
      { audit_entire_solution_path: true, causal_direction_required: true },
      packageValue,
    );

    expect(bound.diagnostic_checks[1]?.causal_direction_check).toMatchObject({
      reference_claimed_reverse_cause_relation: 'baseline_or_prior_different_construct',
      claimed_cause_is_observed_y_causing_x: false,
    });
    expect(bound).toMatchObject({
      verdict: 'fail',
      failure_codes: expect.arrayContaining(['reference_incorrect']),
    });
  });

  it('accepts textbook reverse causation when a prior manifestation is the same outcome construct', () => {
    const independentAudit = audit(5);
    const fixture = interventionRegressionFixture.cases[5];
    if (!fixture) throw new Error('missing valid causal fixture');
    const packageValue = InterventionPackage.parse(fixture.package);
    const output = comparatorOutput(independentAudit) as InterventionPackageReviewStructuredOutputT;
    for (const check of output.diagnostic_checks) {
      check.causal_direction_check = {
        applies: true,
        exposure_x_md: '每周中高强度运动频率',
        observed_outcome_y_md: '抑郁症状严重度',
        reference_reverse_causation_claim_relations:
          extractInterventionReferenceReverseCausationClaims(packageValue, check.kind).map(
            (claim) => ({
              claim_index: claim.claim_index,
              relation: 'same_outcome_construct_y' as const,
              decision_basis_md: '既有状态与题面 outcome 是同一个构念。',
            }),
          ),
      };
    }

    const bound = bindInterventionPackageReviewDecision(
      output,
      independentAudit,
      contentAudit(5),
      { audit_entire_solution_path: true, causal_direction_required: true },
      packageValue,
    );

    expect(bound.verdict).toBe('pass');
    expect(bound.failure_codes).toEqual([]);
    expect(bound.diagnostic_checks[2]?.causal_direction_check).toMatchObject({
      reference_claimed_reverse_cause_relation: 'same_outcome_construct_y',
      claimed_cause_is_observed_y_causing_x: true,
    });
  });

  it('extracts only positive authoritative occurrences with stable UTF-16 provenance', () => {
    const fixture = interventionRegressionFixture.cases[2];
    if (!fixture) throw new Error('missing complex causal fixture');
    const packageValue = structuredClone(InterventionPackage.parse(fixture.package));
    const probe = packageValue.diagnostics.immediate.probe_spec;
    probe.prompt_md += '\n讨论“反向因果”这一术语，但这里不是答案。';
    probe.expected_target_error_answer_md += '；目标错误声称存在反向因果。';
    probe.elicits_target_error_reason_md +=
      '；错误规则还会把“不属于同一 outcome construct 的 Y→X”写成反向因果。';
    packageValue.material.body_md += '\n材料只示范如何质疑反向因果，不提供本题答案。';
    if (probe.target_error_response_signature.kind !== 'text') {
      throw new Error('unexpected complex causal target-error signature');
    }
    probe.target_error_response_signature.response_md +=
      ' 错误答案还声称存在反向因果：另一个基线变量导致 X。';
    probe.reference_md = [
      '🙂反向因果（基线成绩较差者更可能参加补习 X）。',
      '无证据表明存在反向因果。',
      '反向因果：本题不成立。',
      '反向因果是错误的。',
      '什么是反向因果？',
      '不能排除反向因果：同一结果 Y 也可能促使后续选择 X。',
      '不是共同原因，而是反向因果：同一 Y 促使 X。',
      '不存在直接 X→Y 的证据，但可能存在反向因果：观察到的 Y 促使 X。',
      '反向因果：Y→X，而共同原因不成立。',
      '这不是共同原因；这是反向因果。',
    ].join('');
    if (probe.gold_response_signature.kind !== 'text') {
      throw new Error('unexpected complex causal gold signature');
    }
    probe.gold_response_signature.response_md = [
      '“反向因果”：同一 outcome Y 促使 X，而不是基线代理变量。',
      'Reverse causation may explain why observed Y predicts later X.',
      'It is not confounding but reverse causation.',
      'It is not confounding; it is reverse causation.',
      'There is reverse causation.',
      'This is reverse causation.',
      'This pattern demonstrates reverse causation.',
      'Reverse causation is wrong.',
      '基线成绩不属于同一 outcome construct，因此并非 Y→X。',
      '该变量属于同一 outcome construct，但并非 Y→X。',
      '该基线变量不应属于同一 outcome construct 的 Y→X。',
      '该变量属于同一结果构念，但进一步分析仍支持 Y→X。',
      '该变量属于同一结果构念，不是共同原因，而是 Y→X。',
    ].join('\n');

    const claims = extractInterventionReferenceReverseCausationClaims(packageValue, 'immediate');
    expect(claims).toHaveLength(15);
    expect(claims.map((claim) => claim.claim_index)).toEqual(
      Array.from({ length: 15 }, (_, index) => index),
    );
    expect(claims.map((claim) => claim.claim_md)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('基线成绩较差者更可能参加补习'),
        expect.stringContaining('不能排除反向因果'),
        expect.stringContaining('不是共同原因，而是反向因果'),
        expect.stringContaining('但可能存在反向因果'),
        expect.stringContaining('而共同原因不成立'),
        expect.stringContaining('这不是共同原因；这是反向因果'),
        expect.stringContaining('同一 outcome Y 促使 X'),
        expect.stringContaining('Reverse causation may explain'),
        expect.stringContaining('not confounding but reverse causation'),
        expect.stringContaining('not confounding; it is reverse causation'),
        expect.stringContaining('There is reverse causation'),
        expect.stringContaining('This is reverse causation'),
        expect.stringContaining('demonstrates reverse causation'),
        expect.stringContaining('但进一步分析仍支持 Y→X'),
        expect.stringContaining('不是共同原因，而是 Y→X'),
      ]),
    );
    expect(claims.every((claim) => !claim.claim_md.includes('本题不成立'))).toBe(true);
    expect(claims.every((claim) => !claim.claim_md.includes('无证据表明'))).toBe(true);
    expect(claims.every((claim) => !claim.claim_md.includes('什么是'))).toBe(true);
    expect(claims.every((claim) => !claim.claim_md.includes('不属于同一'))).toBe(true);
    expect(claims.every((claim) => !claim.claim_md.includes('不应属于同一'))).toBe(true);
    expect(claims.every((claim) => !claim.claim_md.includes('is wrong'))).toBe(true);
    expect(claims.every((claim) => !claim.claim_md.includes('但并非 Y→X'))).toBe(true);
    expect(
      claims.every(
        (claim) =>
          claim.source_path.includes('.reference_md') ||
          claim.source_path.includes('.gold_response_signature.'),
      ),
    ).toBe(true);
    for (const claim of claims) {
      const source = claim.source_path.endsWith('.reference_md')
        ? probe.reference_md
        : probe.gold_response_signature.response_md;
      expect(source?.slice(claim.excerpt_start_utf16, claim.excerpt_end_utf16)).toBe(
        claim.claim_md,
      );
      expect(source?.slice(claim.marker_start_utf16, claim.marker_end_utf16)).toMatch(
        /因果|reverse\s+caus|Y\s*→\s*X/iu,
      );
      expect(claim.claim_sha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(extractInterventionReferenceReverseCausationClaims(packageValue, 'immediate')).toEqual(
      claims,
    );

    const shifted = structuredClone(packageValue);
    shifted.diagnostics.immediate.probe_spec.reference_md = `前置🙂。${shifted.diagnostics.immediate.probe_spec.reference_md}`;
    const shiftedClaims = extractInterventionReferenceReverseCausationClaims(shifted, 'immediate');
    expect(shiftedClaims[0]?.claim_md).toBe(claims[0]?.claim_md);
    expect(shiftedClaims[0]?.claim_sha256).not.toBe(claims[0]?.claim_sha256);
  });

  it('requires an exact dense provider classification for every server-owned causal claim', () => {
    const caseIndex = 2;
    const independentAudit = audit(caseIndex);
    const fixture = interventionRegressionFixture.cases[caseIndex];
    if (!fixture) throw new Error('missing baseline-selection regression');
    const packageValue = InterventionPackage.parse(fixture.package);
    const output = comparatorOutput(independentAudit) as InterventionPackageReviewStructuredOutputT;
    for (const check of output.diagnostic_checks) {
      check.causal_direction_check = {
        applies: true,
        exposure_x_md: '暴露 X',
        observed_outcome_y_md: '题面实际 outcome Y',
        reference_reverse_causation_claim_relations:
          extractInterventionReferenceReverseCausationClaims(packageValue, check.kind).map(
            (claim) => ({
              claim_index: claim.claim_index,
              relation: 'same_outcome_construct_y' as const,
              decision_basis_md: '逐 occurrence 分类并绑定同一 outcome 构念。',
            }),
          ),
      };
    }
    const delayed = output.diagnostic_checks.find((check) => check.kind === 'delayed');
    if (
      !delayed ||
      delayed.causal_direction_check.reference_reverse_causation_claim_relations.length < 2
    ) {
      throw new Error('complex delayed fixture must expose multiple claims');
    }

    const missing = structuredClone(output);
    missing.diagnostic_checks
      .find((check) => check.kind === 'delayed')
      ?.causal_direction_check.reference_reverse_causation_claim_relations.pop();
    expect(() =>
      bindInterventionPackageReviewDecision(
        missing,
        independentAudit,
        contentAudit(caseIndex),
        { audit_entire_solution_path: true, causal_direction_required: true },
        packageValue,
      ),
    ).toThrow('omitted server-owned reverse-causation claims');

    const reordered = structuredClone(output);
    reordered.diagnostic_checks
      .find((check) => check.kind === 'delayed')
      ?.causal_direction_check.reference_reverse_causation_claim_relations.reverse();
    expect(() =>
      bindInterventionPackageReviewDecision(
        reordered,
        independentAudit,
        contentAudit(caseIndex),
        { audit_entire_solution_path: true, causal_direction_required: true },
        packageValue,
      ),
    ).toThrow('wrong reverse-causation claim');

    const duplicate = structuredClone(output);
    const duplicateRelations = duplicate.diagnostic_checks.find((check) => check.kind === 'delayed')
      ?.causal_direction_check.reference_reverse_causation_claim_relations;
    if (!duplicateRelations?.[1] || !duplicateRelations[0]) {
      throw new Error('complex delayed fixture must expose duplicate-classification coverage');
    }
    duplicateRelations[1].claim_index = duplicateRelations[0].claim_index;
    expect(() =>
      bindInterventionPackageReviewDecision(
        duplicate,
        independentAudit,
        contentAudit(caseIndex),
        { audit_entire_solution_path: true, causal_direction_required: true },
        packageValue,
      ),
    ).toThrow('wrong reverse-causation claim');

    const extra = structuredClone(output);
    extra.diagnostic_checks
      .find((check) => check.kind === 'delayed')
      ?.causal_direction_check.reference_reverse_causation_claim_relations.push({
        claim_index: 2,
        relation: 'same_outcome_construct_y',
        decision_basis_md: 'provider cannot append a classification without a sealed claim.',
      });
    expect(() =>
      bindInterventionPackageReviewDecision(
        extra,
        independentAudit,
        contentAudit(caseIndex),
        { audit_entire_solution_path: true, causal_direction_required: true },
        packageValue,
      ),
    ).toThrow('omitted server-owned reverse-causation claims');

    const mixed = structuredClone(output);
    const mixedRelations = mixed.diagnostic_checks.find((check) => check.kind === 'delayed')
      ?.causal_direction_check.reference_reverse_causation_claim_relations;
    if (!mixedRelations?.[1]) {
      throw new Error('complex delayed fixture must expose mixed-relation coverage');
    }
    mixedRelations[1].relation = 'common_cause_or_other_or_unclear';
    mixedRelations[1].decision_basis_md = '第二个 occurrence 说的是不同变量，不是题面观察到的 Y。';
    expect(
      bindInterventionPackageReviewDecision(
        mixed,
        independentAudit,
        contentAudit(caseIndex),
        { audit_entire_solution_path: true, causal_direction_required: true },
        packageValue,
      ),
    ).toMatchObject({ verdict: 'fail', failure_codes: ['reference_incorrect'] });

    const providerAuthoredClaim = structuredClone(output) as unknown as {
      diagnostic_checks: Array<{
        causal_direction_check: { reference_reverse_causation_claim_relations: unknown[] };
      }>;
    };
    Object.assign(
      providerAuthoredClaim.diagnostic_checks[0]?.causal_direction_check
        .reference_reverse_causation_claim_relations[0] ?? {},
      { source_path: 'provider.authored.path', claim_sha256: 'a'.repeat(64) },
    );
    expect(InterventionPackageReviewStructuredOutput.safeParse(providerAuthoredClaim).success).toBe(
      false,
    );
  });

  it('rejects reverse-causation claim overflow before starting any paid validator', async () => {
    const fixture = interventionRegressionFixture.cases[2];
    if (!fixture) throw new Error('missing causal fixture');
    const packageValue = structuredClone(InterventionPackage.parse(fixture.package));
    packageValue.diagnostics.immediate.probe_spec.reference_md = Array.from(
      { length: 25 },
      (_, index) => `可能存在反向因果：第 ${index + 1} 个同一 Y 状态促使选择 X。`,
    ).join('\n');
    const runTaskFn = vi.fn();

    const result = await reviewInterventionPackageCandidate({
      db: {} as never,
      runTaskFn,
      context: InterventionAuthoringContext.parse(fixture.context),
      packageValue,
      subjectProfile: resolveSubjectProfile(fixture.subject_id),
    });

    expect(result).toMatchObject({
      status: 'invalid',
      failureCode: 'reverse_causation_claim_extraction_invalid',
      taskRunIds: [],
      failureDetail: expect.stringContaining('bounded claim budget'),
    });
    expect(runTaskFn).not.toHaveBeenCalled();
  });

  it('seals unique ordered comparator attempts and pins the bounded call envelope', () => {
    expect(MAX_INTERVENTION_VALIDATOR_CALLS_PER_PACKAGE).toBe(11);
    expect(MAX_INTERVENTION_PREPARATION_CALLS_PER_DELIVERY).toBe(25);
    expect(MAX_INTERVENTION_REVIEW_EVAL_CALLS_PER_CASE).toBe(11);

    const independentAudit = audit();
    const result = bindOutput(comparatorOutput(independentAudit), independentAudit);
    const base = {
      review_version: INTERVENTION_CONTRACT_VERSION,
      package_digest_sha256: independentAudit.package_digest_sha256,
      review_task_run_id: 'review-2',
      review_attempt_task_run_ids: ['review-1', 'review-2'],
      review_task_input_sha256: 'a'.repeat(64),
      independent_solution_audit: independentAudit,
      result,
    };
    expect(InterventionPackageReviewAudit.parse(base)).toMatchObject({
      review_task_run_id: 'review-2',
      review_attempt_task_run_ids: ['review-1', 'review-2'],
    });
    const currentBase = {
      ...base,
      audit_protocol_version: INTERVENTION_REVIEW_AUDIT_PROTOCOL_VERSION,
      question_content_validation_audit: contentAudit(),
      review_attempts: [
        { task_run_id: 'review-1', outcome: 'valid' as const, result },
        { task_run_id: 'review-2', outcome: 'valid' as const, result },
      ],
    };
    expect(CurrentInterventionPackageReviewAudit.parse(currentBase)).toMatchObject({
      audit_protocol_version: 3,
      result: { verdict: 'pass' },
    });
    expect(
      CurrentInterventionPackageReviewAudit.safeParse({
        ...currentBase,
        review_task_run_id: 'review-1',
        review_attempt_task_run_ids: ['review-1'],
        review_attempts: [currentBase.review_attempts[0]],
      }).success,
    ).toBe(false);
    expect(() =>
      InterventionPackageReviewAudit.parse({
        ...base,
        review_attempt_task_run_ids: ['review-2', 'review-1'],
      }),
    ).toThrow();
    expect(() =>
      InterventionPackageReviewAudit.parse({
        ...base,
        review_attempt_task_run_ids: ['review-1', 'review-1'],
      }),
    ).toThrow();
    expect(() =>
      InterventionPackageReviewAudit.parse({
        ...base,
        review_task_run_id: independentAudit.diagnostics[0]?.solver_task_run_id,
        review_attempt_task_run_ids: [independentAudit.diagnostics[0]?.solver_task_run_id],
      }),
    ).toThrow();

    const historicalFullAudit = {
      ...structuredClone(base),
      result: {
        ...structuredClone(base.result),
        diagnostic_checks: base.result.diagnostic_checks.map((check) => {
          const {
            reference_claimed_reverse_cause_relation: _relation,
            reference_reverse_causation_claim_checks: _claimChecks,
            ...historicalCausalDirectionCheck
          } = check.causal_direction_check;
          return {
            ...structuredClone(check),
            causal_direction_check: historicalCausalDirectionCheck,
          };
        }),
      },
    };
    expect(InterventionPackageReviewAudit.safeParse(historicalFullAudit).success).toBe(true);

    const { review_attempt_task_run_ids: _reviewAttempts, ...preOperationHistoricalOuter } =
      historicalFullAudit;
    const preOperationHistoricalAudit = {
      ...preOperationHistoricalOuter,
      independent_solution_audit: {
        ...historicalFullAudit.independent_solution_audit,
        diagnostics: historicalFullAudit.independent_solution_audit.diagnostics.map(
          ({ required_operations: _requiredOperations, ...diagnostic }) => diagnostic,
        ),
      },
      result: {
        ...historicalFullAudit.result,
        diagnostic_checks: historicalFullAudit.result.diagnostic_checks.map(
          ({ required_operation_checks: _operationChecks, ...check }) => check,
        ),
      },
    };
    expect(InterventionPackageReviewAudit.safeParse(preOperationHistoricalAudit).success).toBe(
      true,
    );

    const wideSignalHistoricalAudit = structuredClone(preOperationHistoricalAudit);
    const wideSignalDiagnostic =
      wideSignalHistoricalAudit.independent_solution_audit.diagnostics[0];
    if (!wideSignalDiagnostic) throw new Error('missing historical diagnostic');
    wideSignalDiagnostic.solver_output.reference_solution.expected_signals = Array.from(
      { length: 13 },
      (_, index) =>
        index === 0
          ? `legacy operation ${index + 1}: ${'甲'.repeat(1_050)}`
          : `legacy operation ${index + 1}`,
    );
    wideSignalDiagnostic.solver_output_sha256 = sha256CanonicalJson(
      wideSignalDiagnostic.solver_output,
    );
    const wideSignalCheck = wideSignalHistoricalAudit.result.diagnostic_checks.find(
      (check) => check.kind === wideSignalDiagnostic.kind,
    );
    if (!wideSignalCheck) throw new Error('missing historical diagnostic check');
    wideSignalCheck.independent_solution_sha256 = wideSignalDiagnostic.solver_output_sha256;
    expect(InterventionPackageReviewAudit.safeParse(wideSignalHistoricalAudit).success).toBe(true);

    const { review_task_input_sha256: _reviewInputDigest, ...earliestHistoricalOuter } =
      preOperationHistoricalAudit;
    const earliestHistoricalAudit = {
      ...earliestHistoricalOuter,
      independent_solution_audit: {
        ...preOperationHistoricalAudit.independent_solution_audit,
        diagnostics: preOperationHistoricalAudit.independent_solution_audit.diagnostics.map(
          ({
            solver_output_repair_level: _repairLevel,
            solver_attempt_task_run_ids: _solverAttempts,
            ...diagnostic
          }) => diagnostic,
        ),
      },
    };
    expect(InterventionPackageReviewAudit.safeParse(earliestHistoricalAudit).success).toBe(true);

    const { package_checks: _packageChecks, ...historicalFullResult } = historicalFullAudit.result;
    const historicalSelfReview = {
      ...historicalFullResult,
      diagnostic_checks: historicalFullResult.diagnostic_checks.map((check) => {
        const {
          independent_solution_sha256: _solverDigest,
          required_operation_checks: _operationChecks,
          ...historicalCheck
        } = check;
        return historicalCheck;
      }),
    };
    expect(InterventionPackageReviewModelOutput.safeParse(historicalSelfReview).success).toBe(true);
    expect(InterventionPackageReviewStructuredOutput.safeParse(historicalSelfReview).success).toBe(
      false,
    );
  });
});

describe('enforceInterventionPackageReviewDecision', () => {
  function nonCausalDirectionCheck() {
    return {
      applies: false as const,
      exposure_x_md: '',
      observed_outcome_y_md: '',
      reference_claims_reverse_causation: false,
      reference_claimed_reverse_cause_md: '',
      reference_claimed_reverse_cause_relation: 'none' as const,
      claimed_cause_is_observed_y_causing_x: false,
    };
  }

  function checks(): InterventionPackageReviewDiagnosticCheckT[] {
    return [
      {
        kind: 'immediate' as const,
        independently_derived_answer_md: '2x cos(x²)',
        required_operations_md: '识别复合结构并应用链式法则。',
        reference_correct: true,
        within_frozen_scope: true,
        discipline_grounded: true,
        decision_basis_md:
          '独立结果与 reference 一致，只使用冻结范围内的链式法则，数学结论可复算。',
        causal_direction_check: nonCausalDirectionCheck(),
      },
      {
        kind: 'delayed' as const,
        independently_derived_answer_md: '3(x+1)²',
        required_operations_md: '识别复合结构并应用链式法则。',
        reference_correct: true,
        within_frozen_scope: true,
        discipline_grounded: true,
        decision_basis_md:
          '独立结果与 reference 一致，只使用冻结范围内的链式法则，数学结论可复算。',
        causal_direction_check: nonCausalDirectionCheck(),
      },
      {
        kind: 'transfer' as const,
        independently_derived_answer_md: '-5(w-4)²',
        required_operations_md: '先求面积 length×width，再做多项式乘法。',
        reference_correct: false,
        within_frozen_scope: false,
        discipline_grounded: true,
        decision_basis_md:
          'reference 只给出长度，不是面积；多项式乘法超出冻结范围，面积计算可复算。',
        causal_direction_check: nonCausalDirectionCheck(),
      },
    ];
  }

  it('turns an explicitly found area/reference mismatch and scope expansion into bounded codes', () => {
    const result = enforceInterventionPackageReviewDecision({
      review_protocol_version: 2,
      verdict: 'pass',
      failure_codes: [],
      diagnostic_checks: checks(),
      summary_md: '作者误判为通过。',
    });

    expect(result).toMatchObject({
      verdict: 'fail',
      failure_codes: ['claim_scope_expansion', 'reference_incorrect'],
    });
  });

  it('maps an ungrounded discipline reference to reference_incorrect', () => {
    const diagnosticChecks = checks();
    diagnosticChecks[2] = {
      ...diagnosticChecks[2],
      reference_correct: true,
      within_frozen_scope: true,
      discipline_grounded: false,
      decision_basis_md: '所谓反例的学科方向与文本事实不成立，不能作为唯一 gold。',
    };
    const result = enforceInterventionPackageReviewDecision({
      review_protocol_version: 2,
      verdict: 'pass',
      failure_codes: [],
      diagnostic_checks: diagnosticChecks,
      summary_md: '作者误判为通过。',
    });

    expect(result.verdict).toBe('fail');
    expect(result.failure_codes).toEqual(['reference_incorrect']);
  });

  it('cannot pass when one structurally bound required operation is out of scope', () => {
    const diagnosticChecks = checks();
    diagnosticChecks[2] = {
      ...diagnosticChecks[2],
      reference_correct: true,
      within_frozen_scope: true,
    };
    diagnosticChecks[0] = {
      ...diagnosticChecks[0],
      required_operation_checks: [
        {
          operation_index: 0,
          operation_sha256: 'a'.repeat(64),
          operation_md: '先建立面积等于长乘宽，再进行二次多项式乘法。',
          reference_covers_operation: true,
          within_frozen_scope: false,
          decision_basis_md: '该必要步骤引入冻结 scope 明确排除的面积和多项式乘法。',
        },
      ],
    };
    const result = enforceInterventionPackageReviewDecision({
      review_protocol_version: 2,
      verdict: 'pass',
      failure_codes: [],
      diagnostic_checks: diagnosticChecks,
      summary_md: '局部命中 claim，但完整路径越界。',
    });

    expect(result).toMatchObject({
      verdict: 'fail',
      failure_codes: ['claim_scope_expansion'],
    });
  });

  it('rejects a self-reported baseline-selection claim mislabeled as reverse causation', () => {
    const diagnosticChecks = checks();
    diagnosticChecks[2] = {
      ...diagnosticChecks[2],
      reference_correct: true,
      within_frozen_scope: true,
    };
    diagnosticChecks[1] = {
      ...diagnosticChecks[1],
      reference_correct: true,
      discipline_grounded: true,
      causal_direction_check: {
        applies: true,
        exposure_x_md: '参加补习',
        observed_outcome_y_md: '期末成绩提高幅度',
        reference_claims_reverse_causation: true,
        reference_claimed_reverse_cause_md: '补习前成绩较差导致被安排补习',
        reference_claimed_reverse_cause_relation: 'baseline_or_prior_different_construct',
        claimed_cause_is_observed_y_causing_x: false,
      },
    };

    const result = enforceInterventionPackageReviewDecision({
      review_protocol_version: 2,
      verdict: 'pass',
      failure_codes: [],
      diagnostic_checks: diagnosticChecks,
      summary_md: '作者误判为通过。',
    });

    expect(result.verdict).toBe('fail');
    expect(result.failure_codes).toEqual(['reference_incorrect']);
  });

  it('keeps legacy persisted review attempts readable without admitting them as new output', () => {
    expect(
      InterventionPackageReviewModelOutput.parse({
        verdict: 'fail',
        failure_codes: ['answer_not_unique'],
        summary_md: 'legacy persisted review',
      }),
    ).toEqual({
      verdict: 'fail',
      failure_codes: ['answer_not_unique'],
      summary_md: 'legacy persisted review',
    });
  });
});
