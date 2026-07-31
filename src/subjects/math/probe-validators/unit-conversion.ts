import type {
  ConjectureProbeSpecV2T,
  SubjectProbeValidatorFailureCodeT,
  SubjectProbeValidatorResultT,
} from '@/core/schema/business';
import type { SubjectProbeValidator, SubjectProbeValidatorInput } from '@/subjects/probe-quality';
import {
  type Rational,
  divideRationals,
  formatRational,
  multiplyRationals,
  normalizeLatexFractions,
  parseDecimalRational,
  rational,
  rationalsEqual,
} from './rational';
import {
  deterministicAnswerGroupMatches,
  deterministicProbeAnswers,
  deterministicProbeQuestionStem,
} from './response';

const VALIDATOR_ID = 'math.compound-unit-denominator-conversion';
const VALIDATOR_VERSION = '1.0.0';

interface UnitDefinition {
  numeratorMeters: bigint;
  denominatorSeconds: bigint | null;
}

const UNITS: Record<string, UnitDefinition> = {
  'km/h': { numeratorMeters: 1000n, denominatorSeconds: 3600n },
  'km/s': { numeratorMeters: 1000n, denominatorSeconds: 1n },
  'm/h': { numeratorMeters: 1n, denominatorSeconds: 3600n },
  'm/s': { numeratorMeters: 1n, denominatorSeconds: 1n },
  km: { numeratorMeters: 1000n, denominatorSeconds: null },
  m: { numeratorMeters: 1n, denominatorSeconds: null },
};

interface ParsedUnitPrompt {
  value: Rational;
  sourceUnit: string;
  targetUnit: string;
}

interface ParsedUnitAnswer {
  value: Rational;
  unit: string;
}

function normalizeUnitText(value: string): string {
  return normalizeLatexFractions(value.replace(/[−–—]/g, '-'))
    .normalize('NFKC')
    .replace(/\\(?:,|;|!|quad|qquad| )/g, ' ')
    .replace(/\\mathrm\s*\{([^{}]+)\}/g, '$1')
    .replace(/公里\s*\/\s*(?:小时|时)/g, 'km/h')
    .replace(/千米\s*\/\s*(?:小时|时)/g, 'km/h')
    .replace(/公里\s*每\s*(?:小时|时)/g, 'km/h')
    .replace(/千米\s*每\s*(?:小时|时)/g, 'km/h')
    .replace(/米\s*\/\s*秒/g, 'm/s')
    .replace(/米\s*每\s*秒/g, 'm/s')
    .replace(/\bkm\s*(?:·|\*)?\s*h\s*\^\s*-?1\b/gi, 'km/h')
    .replace(/\bm\s*(?:·|\*)?\s*s\s*\^\s*-?1\b/gi, 'm/s')
    .toLowerCase();
}

function unitMatches(value: string): Array<{ unit: string; index: number; end: number }> {
  const matches: Array<{ unit: string; index: number; end: number }> = [];
  const pattern = /(?<![a-z])(?:km\/h|km\/s|m\/h|m\/s|km|m)(?![a-z])/g;
  for (const match of value.matchAll(pattern)) {
    if (match.index === undefined || !match[0]) continue;
    matches.push({ unit: match[0], index: match.index, end: match.index + match[0].length });
  }
  return matches;
}

function parsePrompt(prompt: string): ParsedUnitPrompt | null {
  const normalized = normalizeUnitText(prompt);
  const units = unitMatches(normalized);
  if (units.length !== 2) return null;
  const source = units[0];
  const target = units[1];
  const direction = normalized.slice(source.end, target.index);
  if (!/(?:到|换算(?:为|成)|化为|变为|折算为|->|→|\bto\b)/.test(direction)) return null;
  const directionForStepCheck = direction.replace(/->|→/g, '');
  const multiStepSignal =
    /[+\-*×÷=]|\d|(?:然后|之后|以后|后再|再|then|after|multiply|divide|add|subtract)|倍|乘|除|加|减|平方|开方|倒数|绝对值|absolute\s+value|\babs\b/i;
  if (multiStepSignal.test(directionForStepCheck)) return null;
  const beforeSource = normalized.slice(0, source.index);
  const numberPattern = /(?<![\w.])([+-]?\d+(?:\.\d+)?)(?![\d.])/g;
  const numbers = [...beforeSource.matchAll(numberPattern)];
  if ([...normalized.matchAll(numberPattern)].length !== 1) return null;
  // Remove the signed source literal itself, then reject any operation wrapped
  // around it before the source unit (for example "两倍的 72 km/h"). The sign
  // of a negative source quantity is part of the literal and is not a step.
  const beforeSourceForStepCheck = beforeSource.replace(numberPattern, '');
  if (multiStepSignal.test(beforeSourceForStepCheck)) return null;
  const afterTarget = normalized.slice(target.end);
  if (multiStepSignal.test(afterTarget)) return null;
  const rawValue = numbers.at(-1)?.[1];
  const value = rawValue ? parseDecimalRational(rawValue) : null;
  if (!value) return null;
  return { value, sourceUnit: source.unit, targetUnit: target.unit };
}

function parseAnswer(answer: string): ParsedUnitAnswer | null {
  const normalized = normalizeUnitText(answer);
  const valuePattern = String.raw`([+-]?\d+(?:\s*\/\s*\d+|\.\d+)?)(?![\d.])`;
  const unitPattern = String.raw`(km\/h|km\/s|m\/h|m\/s|km|m)(?![a-z])`;
  const matches = [
    ...normalized.matchAll(new RegExp(String.raw`(?<![\w.])${valuePattern}\s*${unitPattern}`, 'g')),
  ];
  // Worked solutions often mention the source quantity after the stated answer.
  // Prefer explicit answer syntax, a leading answer, or an equation result; an
  // unmarked multi-quantity response is ambiguous and therefore ungradable.
  const marker = new RegExp(
    String.raw`(?:答案|结果|答|answer|result)\s*(?:是|为|[:：=])?\s*${valuePattern}\s*${unitPattern}`,
    'i',
  ).exec(normalized);
  const leading = new RegExp(String.raw`^\s*${valuePattern}\s*${unitPattern}`, 'i').exec(
    normalized,
  );
  const equationResults = [
    ...normalized.matchAll(new RegExp(String.raw`=\s*${valuePattern}\s*${unitPattern}`, 'gi')),
  ];
  const selected =
    marker ?? equationResults.at(-1) ?? leading ?? (matches.length === 1 ? matches[0] : null);
  const rawValue = selected?.[1]?.replace(/\s+/g, '');
  const value = rawValue?.includes('/')
    ? (() => {
        const [numerator, denominator] = rawValue.split('/');
        return numerator && denominator ? rational(BigInt(numerator), BigInt(denominator)) : null;
      })()
    : rawValue
      ? parseDecimalRational(rawValue)
      : null;
  const unit = selected?.[2];
  return value && unit ? { value, unit } : null;
}

function unitScale(unit: UnitDefinition): Rational | null {
  return unit.denominatorSeconds === null
    ? rational(unit.numeratorMeters, 1n)
    : rational(unit.numeratorMeters, unit.denominatorSeconds);
}

function expectedAnswers(parsed: ParsedUnitPrompt): {
  gold: Rational;
  targetError: Rational;
} | null {
  const source = UNITS[parsed.sourceUnit];
  const target = UNITS[parsed.targetUnit];
  if (!source || !target) return null;
  const sourceScale = unitScale(source);
  const targetScale = unitScale(target);
  const numeratorOnlyScale = rational(source.numeratorMeters, target.numeratorMeters);
  if (!sourceScale || !targetScale || !numeratorOnlyScale) return null;
  const completeFactor = divideRationals(sourceScale, targetScale);
  if (!completeFactor) return null;
  return {
    gold: multiplyRationals(parsed.value, completeFactor),
    targetError: multiplyRationals(parsed.value, numeratorOnlyScale),
  };
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
  const unitSignal =
    /单位换算|复合单位|速度单位|unit conversion|compound unit|km\s*\/\s*h|m\s*\/\s*s/.test(
      contract,
    );
  const denominatorSignal = /分母|每小时|每秒|denominator|per hour|per second|时间单位/.test(
    contract,
  );
  // Require the frozen misconception contract to explicitly describe changing
  // only the numerator/distance side or omitting the denominator/time side.
  const targetRuleSignal =
    /只[\s\S]{0,16}(?:分子|距离|长度)|(?:忘|未)[\s\S]{0,16}(?:分母|时间)|only[\s\S]{0,40}(?:numerator|distance)|without[\s\S]{0,40}(?:denominator|time)/.test(
      contract,
    );
  return unitSignal && denominatorSignal && targetRuleSignal;
}

function validateProbe(
  probe: ConjectureProbeSpecV2T,
  label: 'primary' | 'followup',
  failureCodes: Set<SubjectProbeValidatorFailureCodeT>,
  evidence: Record<string, string>,
): ParsedUnitPrompt | null {
  const parsed = parsePrompt(deterministicProbeQuestionStem(probe));
  const answers = deterministicProbeAnswers(probe);
  if (!parsed || !answers) {
    failureCodes.add('subject_validator_ungradable');
    evidence[`${label}_parse`] = 'ungradable';
    return null;
  }
  evidence[`${label}_conversion`] =
    `${formatRational(parsed.value)} ${parsed.sourceUnit} -> ${parsed.targetUnit}`;
  const source = UNITS[parsed.sourceUnit];
  const target = UNITS[parsed.targetUnit];
  if (!source || !target) {
    failureCodes.add('subject_validator_ungradable');
    return parsed;
  }
  if (
    source.denominatorSeconds === null ||
    target.denominatorSeconds === null ||
    source.denominatorSeconds === target.denominatorSeconds
  ) {
    failureCodes.add('unit_denominator_trigger_missing');
  }
  if ((source.denominatorSeconds === null) !== (target.denominatorSeconds === null)) {
    failureCodes.add('unit_dimension_mismatch');
  }
  const expected = expectedAnswers(parsed);
  if (!expected) {
    failureCodes.add('subject_validator_ungradable');
    return parsed;
  }
  evidence[`${label}_gold`] = `${formatRational(expected.gold)} ${parsed.targetUnit}`;
  evidence[`${label}_target_error`] =
    `${formatRational(expected.targetError)} ${parsed.targetUnit}`;
  if (rationalsEqual(expected.gold, expected.targetError)) {
    failureCodes.add('unit_target_collides_with_gold');
  }
  const goldMatches = deterministicAnswerGroupMatches(answers.gold, (answer) => {
    const actual = parseAnswer(answer);
    return (
      actual !== null &&
      actual.unit === parsed.targetUnit &&
      rationalsEqual(actual.value, expected.gold)
    );
  });
  if (!goldMatches) failureCodes.add('unit_reference_mismatch');
  const targetMatches = deterministicAnswerGroupMatches(answers.target, (answer) => {
    const actual = parseAnswer(answer);
    return (
      actual !== null &&
      actual.unit === parsed.targetUnit &&
      rationalsEqual(actual.value, expected.targetError)
    );
  });
  if (!targetMatches) failureCodes.add('unit_target_signature_mismatch');
  return parsed;
}

export const compoundUnitDenominatorConversionValidator: SubjectProbeValidator = {
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
      primary.sourceUnit === followup.sourceUnit &&
      primary.targetUnit === followup.targetUnit &&
      input.package.primary.representation_kind === input.package.followup.representation_kind
    ) {
      failureCodes.add('unit_pair_not_independent');
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
