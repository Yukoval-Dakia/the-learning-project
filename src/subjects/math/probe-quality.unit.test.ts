import type {
  ConjectureHypothesisProposalDraftT,
  ConjectureProbePackageV2T,
  ConjectureProbeSpecV2T,
} from '@/core/schema/business';
import { evaluateSubjectProbeValidators } from '@/subjects/probe-quality';
import { describe, expect, it } from 'vitest';
import './probe-quality';

function shortProbe(input: {
  prompt: string;
  gold: string;
  target: string;
  context: ConjectureProbeSpecV2T['context_kind'];
  representation: ConjectureProbeSpecV2T['representation_kind'];
}): ConjectureProbeSpecV2T {
  return {
    schema_version: 2,
    prompt_md: input.prompt,
    reference_md: input.gold,
    expected_target_error_answer_md: input.target,
    elicits_target_error_reason_md: '直接诱发冻结合同中的目标错误。',
    context_kind: input.context,
    representation_kind: input.representation,
    response_mode: 'short_answer',
    gold_response_signature: { kind: 'text', response_md: input.gold },
    target_error_response_signature: { kind: 'text', response_md: input.target },
  };
}

const unitHypothesis: ConjectureHypothesisProposalDraftT = {
  kind: 'proposal',
  claim_md: '你在复合速度单位换算时只换分子距离单位，忘记换分母时间单位。',
  knowledge_id: 'kc_unit_conversion',
  evidence_event_ids: ['evt_unit_a', 'evt_unit_b'],
  diagnostic_spec: {
    schema_version: 1,
    target_error_rule_md: '只换算分子距离单位，不换算分母时间单位。',
    trigger_conditions_md: '题目要求在 km/h 与 m/s 之间做速度单位换算。',
    scope_boundary_md: '只覆盖复合速度单位换算。',
    expected_wrong_answer_signature_md: '分母的每小时或每秒倍率保持不变。',
  },
  cause_category: 'unit_error',
  recurrence_count: 2,
};

const unitPackage: ConjectureProbePackageV2T = {
  primary: shortProbe({
    prompt: 'Convert 72 km/h to m/s.',
    gold: '20 m/s',
    target: '72000 m/s',
    context: 'abstract',
    representation: 'symbolic',
  }),
  followup: shortProbe({
    prompt: '将 10 m/s 换算为 km/h。',
    gold: '36 km/h',
    target: '0.01 km/h',
    context: 'applied',
    representation: 'natural_language',
  }),
  predicted_p: 0.35,
};

const fractionHypothesis: ConjectureHypothesisProposalDraftT = {
  kind: 'proposal',
  claim_md: '你做异分母分数加法时把分子和分母分别相加。',
  knowledge_id: 'kc_fraction_addition',
  evidence_event_ids: ['evt_fraction_a', 'evt_fraction_b'],
  diagnostic_spec: {
    schema_version: 1,
    target_error_rule_md: '异分母分数相加时错误地计算 (a+c)/(b+d)。',
    trigger_conditions_md: '两个加数的分母不同。',
    scope_boundary_md: '只覆盖两个普通分数的一步加法。',
    expected_wrong_answer_signature_md: '分子分别相加且分母分别相加。',
  },
  cause_category: 'calculation',
  recurrence_count: 2,
};

const fractionPackage: ConjectureProbePackageV2T = {
  primary: shortProbe({
    prompt: '计算 1/3 + 1/4。',
    gold: '7/12',
    target: '2/7',
    context: 'abstract',
    representation: 'symbolic',
  }),
  followup: shortProbe({
    prompt: '一段绳长 2/5 米，另一段长 1/3 米，合起来一共多长？',
    gold: '11/15 米',
    target: '3/8 米',
    context: 'applied',
    representation: 'natural_language',
  }),
  predicted_p: 0.3,
};

function resultFor(
  hypothesis: ConjectureHypothesisProposalDraftT,
  packageValue: ConjectureProbePackageV2T,
  validatorId: string,
) {
  const result = evaluateSubjectProbeValidators('math', {
    hypothesis,
    package: packageValue,
  }).find((candidate) => candidate.validator_id === validatorId);
  if (!result) throw new Error(`missing validator ${validatorId}`);
  return result;
}

describe('math subject probe validators', () => {
  it('proves km/h -> m/s and the reverse denominator-time conversion', () => {
    const result = resultFor(
      unitHypothesis,
      unitPackage,
      'math.compound-unit-denominator-conversion',
    );
    expect(result).toMatchObject({
      outcome: 'pass',
      failure_codes: [],
      evidence: {
        primary_gold: '20 m/s',
        primary_target_error: '72000 m/s',
        followup_gold: '36 km/h',
        followup_target_error: '1/100 km/h',
      },
    });
  });

  it.each([
    [
      'denominator unchanged',
      (draft: ConjectureProbePackageV2T) => {
        draft.followup.prompt_md = '将 10 m/h 换算为 km/h。';
      },
      'unit_denominator_trigger_missing',
    ],
    [
      'dimension mismatch',
      (draft: ConjectureProbePackageV2T) => {
        draft.primary.prompt_md = 'Convert 72 km/h to m.';
      },
      'unit_dimension_mismatch',
    ],
    [
      'wrong gold',
      (draft: ConjectureProbePackageV2T) => {
        draft.primary.reference_md = '21 m/s';
      },
      'unit_reference_mismatch',
    ],
    [
      'ambiguous unit',
      (draft: ConjectureProbePackageV2T) => {
        draft.primary.prompt_md = 'Convert 72 speed units to m/s.';
      },
      'subject_validator_ungradable',
    ],
    [
      'wrong target signature',
      (draft: ConjectureProbePackageV2T) => {
        draft.primary.target_error_response_signature = {
          kind: 'text',
          response_md: '72 m/s',
        };
      },
      'unit_target_signature_mismatch',
    ],
  ])('fails closed for unit mutation: %s', (_name, mutate, expectedCode) => {
    const mutated = structuredClone(unitPackage);
    mutate(mutated);
    const result = resultFor(unitHypothesis, mutated, 'math.compound-unit-denominator-conversion');
    expect(result.outcome).toBe('fail');
    expect(result.failure_codes).toContain(expectedCode);
  });

  it('detects a target error that collides with gold when the denominator did not change', () => {
    const mutated = structuredClone(unitPackage);
    mutated.primary.prompt_md = 'Convert 72 km/h to m/h.';
    mutated.primary.reference_md = '72000 m/h';
    mutated.primary.gold_response_signature = { kind: 'text', response_md: '72000 m/h' };
    mutated.primary.expected_target_error_answer_md = '72000 m/h';
    mutated.primary.target_error_response_signature = {
      kind: 'text',
      response_md: '72000 m/h',
    };
    const result = resultFor(unitHypothesis, mutated, 'math.compound-unit-denominator-conversion');
    expect(result.outcome).toBe('fail');
    expect(result.failure_codes).toEqual(
      expect.arrayContaining([
        'unit_denominator_trigger_missing',
        'unit_target_collides_with_gold',
      ]),
    );
  });

  it('accepts exact rational unit answers that cannot be written as finite decimals', () => {
    const mutated = structuredClone(unitPackage);
    mutated.primary.prompt_md = 'Convert 1 km/h to m/s.';
    mutated.primary.reference_md = '5/18 m/s';
    mutated.primary.gold_response_signature = { kind: 'text', response_md: '5/18 m/s' };
    mutated.primary.expected_target_error_answer_md = '1000 m/s';
    mutated.primary.target_error_response_signature = {
      kind: 'text',
      response_md: '1000 m/s',
    };
    expect(
      resultFor(unitHypothesis, mutated, 'math.compound-unit-denominator-conversion').outcome,
    ).toBe('pass');
  });

  it('proves unlike-denominator gold and (a+c)/(b+d) target signatures', () => {
    const result = resultFor(
      fractionHypothesis,
      fractionPackage,
      'math.unlike-denominator-fraction-addition',
    );
    expect(result).toMatchObject({
      outcome: 'pass',
      failure_codes: [],
      evidence: {
        primary_gold: '7/12',
        primary_target_error: '2/7',
        followup_gold: '11/15',
        followup_target_error: '3/8',
      },
    });
  });

  it.each([
    [
      'same denominator follow-up',
      (draft: ConjectureProbePackageV2T) => {
        draft.followup.prompt_md = '计算 2/5 + 1/5。';
      },
      'fraction_unlike_denominator_trigger_missing',
    ],
    [
      'wrong gold',
      (draft: ConjectureProbePackageV2T) => {
        draft.primary.reference_md = '8/12';
      },
      'fraction_reference_mismatch',
    ],
    [
      'wrong target signature',
      (draft: ConjectureProbePackageV2T) => {
        draft.primary.expected_target_error_answer_md = '3/7';
      },
      'fraction_target_signature_mismatch',
    ],
    [
      'multi-step prompt',
      (draft: ConjectureProbePackageV2T) => {
        draft.primary.prompt_md = '先计算 1/3 + 1/4，再减去 1/5。';
      },
      'subject_validator_ungradable',
    ],
  ])('fails closed for fraction mutation: %s', (_name, mutate, expectedCode) => {
    const mutated = structuredClone(fractionPackage);
    mutate(mutated);
    const result = resultFor(
      fractionHypothesis,
      mutated,
      'math.unlike-denominator-fraction-addition',
    );
    expect(result.outcome).toBe('fail');
    expect(result.failure_codes).toContain(expectedCode);
  });

  it('detects reduced target/gold collision instead of accepting textual difference', () => {
    const mutated = structuredClone(fractionPackage);
    mutated.primary.prompt_md = '计算 4/2 + -9/3。';
    mutated.primary.reference_md = '-1';
    mutated.primary.gold_response_signature = { kind: 'text', response_md: '-1' };
    mutated.primary.expected_target_error_answer_md = '-5/5';
    mutated.primary.target_error_response_signature = { kind: 'text', response_md: '-5/5' };
    const result = resultFor(
      fractionHypothesis,
      mutated,
      'math.unlike-denominator-fraction-addition',
    );
    expect(result.outcome).toBe('fail');
    expect(result.failure_codes).toContain('fraction_target_collides_with_gold');
  });

  it('reads an answer stated before its derivation instead of the last intermediate integer', () => {
    const mutated = structuredClone(fractionPackage);
    const workedAnswer = '7/12，因为 1×4+1×3=7，3×4=12';
    mutated.primary.reference_md = workedAnswer;
    mutated.primary.gold_response_signature = { kind: 'text', response_md: workedAnswer };
    expect(
      resultFor(fractionHypothesis, mutated, 'math.unlike-denominator-fraction-addition').outcome,
    ).toBe('pass');
  });

  it('requires a different fraction context or representation', () => {
    const mutated = structuredClone(fractionPackage);
    mutated.followup.context_kind = mutated.primary.context_kind;
    mutated.followup.representation_kind = mutated.primary.representation_kind;
    const result = resultFor(
      fractionHypothesis,
      mutated,
      'math.unlike-denominator-fraction-addition',
    );
    expect(result.outcome).toBe('fail');
    expect(result.failure_codes).toContain('fraction_pair_not_independent');
  });

  it('does not block unknown patterns or subjects', () => {
    const mathResults = evaluateSubjectProbeValidators('math', {
      hypothesis: {
        ...fractionHypothesis,
        claim_md: '你在链式法则中把两层导数相加。',
        diagnostic_spec: {
          ...fractionHypothesis.diagnostic_spec,
          target_error_rule_md: '把外层导数与内层导数相加。',
          trigger_conditions_md: '复合函数求导。',
          expected_wrong_answer_signature_md: 'outer + inner',
        },
      },
      package: fractionPackage,
    });
    expect(mathResults.map((result) => result.outcome)).toEqual([
      'not_applicable',
      'not_applicable',
    ]);
    expect(
      evaluateSubjectProbeValidators('yuwen', {
        hypothesis: fractionHypothesis,
        package: fractionPackage,
      }),
    ).toEqual([]);
  });
});
