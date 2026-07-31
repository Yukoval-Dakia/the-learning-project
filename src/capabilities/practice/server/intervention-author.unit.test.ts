import {
  type InterventionPackageReviewDiagnosticCheckT,
  InterventionPackageReviewModelOutput,
} from '@/core/schema/intervention';
import { describe, expect, it } from 'vitest';
import {
  enforceInterventionPackageReviewDecision,
  normalizeInterventionPackageModelOutput,
} from './intervention-author';

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
