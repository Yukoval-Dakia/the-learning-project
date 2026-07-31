import {
  InterventionIndependentSolutionAudit,
  type InterventionPackageReviewDiagnosticCheckT,
  InterventionPackageReviewModelOutput,
} from '@/core/schema/intervention';
import { sha256CanonicalJson } from '@/kernel/canonical-json';
import interventionRegressionFixture from '@/server/grounding-gate/fixtures/intervention-review-regressions.v1.json' with {
  type: 'json',
};
import { describe, expect, it } from 'vitest';
import {
  bindInterventionPackageReviewDecision,
  enforceInterventionPackageReviewDecision,
  normalizeInterventionPackageModelOutput,
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
  function audit() {
    const fixture = interventionRegressionFixture.cases[0];
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
        };
      }),
    });
  }

  function comparatorOutput(independentAudit = audit()) {
    return {
      review_protocol_version: 2 as const,
      verdict: 'pass' as const,
      failure_codes: [],
      diagnostic_checks: independentAudit.diagnostics.map((diagnostic) => ({
        kind: diagnostic.kind,
        independent_solution_sha256: diagnostic.solver_output_sha256,
        reference_correct: true,
        within_frozen_scope: true,
        discipline_grounded: true,
        decision_basis_md: '密封盲解与 reference、冻结范围和学科事实一致。',
        causal_direction_check: {
          applies: false,
          exposure_x_md: '',
          observed_outcome_y_md: '',
          reference_claims_reverse_causation: false,
          reference_claimed_reverse_cause_md: '',
          claimed_cause_is_observed_y_causing_x: false,
        },
      })),
      package_checks: passingPackageChecks(),
      summary_md: '密封盲解和包级检查全部通过。',
    };
  }

  it('server-binds the persisted answer/operations and rejects a wrong sealed digest', () => {
    const independentAudit = audit();
    const bound = bindInterventionPackageReviewDecision(
      comparatorOutput(independentAudit),
      independentAudit,
    );
    expect(bound.verdict).toBe('pass');
    expect(bound.diagnostic_checks[2]).toMatchObject({
      kind: 'transfer',
      independent_solution_sha256: independentAudit.diagnostics[2]?.solver_output_sha256,
      independently_derived_answer_md: '-5(w-4)² = -5w²+40w-80 平方米',
      required_operations_md: expect.stringContaining('面积=长×宽'),
    });

    const mismatched = comparatorOutput(independentAudit);
    if (!mismatched.diagnostic_checks[2]) throw new Error('missing transfer check');
    mismatched.diagnostic_checks[2].independent_solution_sha256 = 'f'.repeat(64);
    expect(() => bindInterventionPackageReviewDecision(mismatched, independentAudit)).toThrow(
      'wrong sealed solution',
    );
  });

  it('maps a contradictory package-level bare pass to a bounded fail code', () => {
    const independentAudit = audit();
    const output = comparatorOutput(independentAudit);
    output.package_checks.material_grounded = false;
    const bound = bindInterventionPackageReviewDecision(output, independentAudit);
    expect(bound).toMatchObject({
      verdict: 'fail',
      failure_codes: ['material_not_grounded'],
    });
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
