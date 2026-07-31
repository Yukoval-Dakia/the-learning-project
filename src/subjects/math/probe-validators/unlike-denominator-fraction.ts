import type {
  ConjectureProbeSpecV2T,
  SubjectProbeValidatorFailureCodeT,
  SubjectProbeValidatorResultT,
} from '@/core/schema/business';
import type { SubjectProbeValidator, SubjectProbeValidatorInput } from '@/subjects/probe-quality';
import {
  type Rational,
  addRationals,
  extractFinalRational,
  formatRational,
  normalizeLatexFractions,
  rational,
  rationalsEqual,
} from './rational';
import { deterministicProbeAnswers } from './response';

const VALIDATOR_ID = 'math.unlike-denominator-fraction-addition';
const VALIDATOR_VERSION = '1.0.0';

interface WrittenFraction {
  numerator: bigint;
  denominator: bigint;
  value: Rational;
}

interface ParsedFractionPrompt {
  left: WrittenFraction;
  right: WrittenFraction;
}

function parsePrompt(prompt: string): ParsedFractionPrompt | null {
  const normalized = normalizeLatexFractions(prompt.replace(/[−–—]/g, '-')).normalize('NFKC');
  if (/\d+\s+\d+\s*\/\s*\d+/.test(normalized)) return null;
  const matches = [...normalized.matchAll(/([+-]?\d+)\s*\/\s*(\d+)/g)];
  if (matches.length !== 2) return null;
  // A plus sign or an unambiguous addition phrase is required; merely
  // mentioning two fractions is not enough to claim this validator owns it.
  const additionIntent = /\+|相加|合计|总共|一共|共(?:有|为|是)?|合起来|add|sum|total/i.test(
    normalized,
  );
  if (!additionIntent) return null;
  const stripped = normalized.replace(/([+-]?\d+)\s*\/\s*(\d+)/g, '#');
  // Fractions are already replaced by "#"; a remaining "# - #" is a real
  // subtraction step rather than the sign of a negative operand. Any remaining
  // number or multiplier phrase also proves the prompt is not a one-step sum.
  if (
    /#\s*-\s*#|[×*÷]|\d|减去|乘|除以|倍|翻倍|还剩|剩下|剩余|差|先.{0,30}再|\b(?:then|after|subtract|multiply|divide|double|twice|times|remaining)\b/i.test(
      stripped,
    )
  ) {
    return null;
  }
  if ((stripped.match(/\+/g) ?? []).length > 1) return null;
  const operands = matches.map((match): WrittenFraction | null => {
    const numerator = BigInt(match[1] ?? '0');
    const denominator = BigInt(match[2] ?? '0');
    const value = rational(numerator, denominator);
    return value ? { numerator, denominator, value } : null;
  });
  const left = operands[0];
  const right = operands[1];
  return left && right ? { left, right } : null;
}

function contractApplies(input: SubjectProbeValidatorInput): boolean {
  const contract = [
    input.hypothesis.claim_md,
    input.hypothesis.diagnostic_spec.target_error_rule_md,
    input.hypothesis.diagnostic_spec.trigger_conditions_md,
    input.hypothesis.diagnostic_spec.expected_wrong_answer_signature_md,
  ]
    .join(' ')
    .normalize('NFKC')
    .toLowerCase();
  const denominatorSignal = /异分母|不同分母|unlike denominator|different denominator/.test(
    contract,
  );
  // Match only the frozen "(a+c)/(b+d)" misconception, not arbitrary
  // fraction-language hypotheses that belong to other validators.
  const targetRuleSignal =
    /分子.{0,12}分母.{0,12}(?:分别)?相加|分子分母分别相加|\(\s*a\s*\+\s*c\s*\)\s*\/\s*\(\s*b\s*\+\s*d\s*\)|add.{0,30}numerator.{0,30}denominator/.test(
      contract,
    );
  return denominatorSignal && targetRuleSignal;
}

function validateProbe(
  probe: ConjectureProbeSpecV2T,
  label: 'primary' | 'followup',
  failureCodes: Set<SubjectProbeValidatorFailureCodeT>,
  evidence: Record<string, string>,
): ParsedFractionPrompt | null {
  const parsed = parsePrompt(probe.prompt_md);
  const answers = deterministicProbeAnswers(probe);
  if (!parsed || !answers) {
    failureCodes.add('subject_validator_ungradable');
    evidence[`${label}_parse`] = 'ungradable';
    return null;
  }
  evidence[`${label}_operands`] =
    `${parsed.left.numerator}/${parsed.left.denominator} + ` +
    `${parsed.right.numerator}/${parsed.right.denominator}`;
  if (parsed.left.denominator === parsed.right.denominator) {
    failureCodes.add('fraction_unlike_denominator_trigger_missing');
  }
  const gold = addRationals(parsed.left.value, parsed.right.value);
  const targetError = rational(
    parsed.left.numerator + parsed.right.numerator,
    parsed.left.denominator + parsed.right.denominator,
  );
  if (!targetError) {
    failureCodes.add('subject_validator_ungradable');
    return null;
  }
  evidence[`${label}_gold`] = formatRational(gold);
  evidence[`${label}_target_error`] = formatRational(targetError);
  if (rationalsEqual(gold, targetError)) {
    failureCodes.add('fraction_target_collides_with_gold');
  }
  const goldMatches = answers.gold.every((answer) => {
    const actual = extractFinalRational(answer);
    return actual !== null && rationalsEqual(actual, gold);
  });
  if (!goldMatches) failureCodes.add('fraction_reference_mismatch');
  const targetMatches = answers.target.every((answer) => {
    const actual = extractFinalRational(answer);
    return actual !== null && rationalsEqual(actual, targetError);
  });
  if (!targetMatches) failureCodes.add('fraction_target_signature_mismatch');
  return parsed;
}

export const unlikeDenominatorFractionAdditionValidator: SubjectProbeValidator = {
  id: VALIDATOR_ID,
  version: VALIDATOR_VERSION,
  validate(input): SubjectProbeValidatorResultT {
    if (!contractApplies(input)) {
      return {
        validator_id: VALIDATOR_ID,
        validator_version: VALIDATOR_VERSION,
        outcome: 'not_applicable',
        failure_codes: [],
        evidence: { applicability: 'contract_not_matched' },
      };
    }
    const failureCodes = new Set<SubjectProbeValidatorFailureCodeT>();
    const evidence: Record<string, string> = { applicability: 'contract_matched' };
    const primary = validateProbe(input.package.primary, 'primary', failureCodes, evidence);
    const followup = validateProbe(input.package.followup, 'followup', failureCodes, evidence);
    if (
      primary &&
      followup &&
      input.package.primary.context_kind === input.package.followup.context_kind &&
      input.package.primary.representation_kind === input.package.followup.representation_kind
    ) {
      failureCodes.add('fraction_pair_not_independent');
    }
    if (failureCodes.size > 0) {
      return {
        validator_id: VALIDATOR_ID,
        validator_version: VALIDATOR_VERSION,
        outcome: 'fail',
        failure_codes: [...failureCodes],
        evidence,
      };
    }
    return {
      validator_id: VALIDATOR_ID,
      validator_version: VALIDATOR_VERSION,
      outcome: 'pass',
      failure_codes: [],
      evidence,
    };
  },
};
