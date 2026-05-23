import { unit } from 'mathjs';

import type { SignalKindT } from './types';

export interface AcceleratorResult {
  parsed: boolean;
  value_si: number | null;
  unit_si: string | null;
  dimension_match: boolean;
  unit_exact_match: boolean;
  value_match: boolean;
  value_close: boolean;
  signal: SignalKindT | null;
}

const NUMERIC_ONLY_RE = /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

export function runAccelerator(input: {
  student_answer: string;
  reference: { value: number; unit: string; tolerance: number };
}): AcceleratorResult {
  const rawAnswer = input.student_answer.trim();
  if (NUMERIC_ONLY_RE.test(rawAnswer)) {
    return unparsed('missing_unit');
  }

  try {
    const studentUnit = unit(rawAnswer);
    const referenceUnit = unit(1, input.reference.unit);
    const dimensionMatch = studentUnit.equalBase(referenceUnit);
    if (!dimensionMatch) {
      return {
        parsed: true,
        value_si: null,
        unit_si: studentUnit.formatUnits(),
        dimension_match: false,
        unit_exact_match: false,
        value_match: false,
        value_close: false,
        signal: 'dimension_mismatch',
      };
    }

    const studentValueInReferenceUnit = studentUnit.toNumber(input.reference.unit);
    const studentUnitLiteral = studentUnit.formatUnits();
    const referenceUnitLiteral = referenceUnit.formatUnits();
    const unitExactMatch = studentUnitLiteral === referenceUnitLiteral;
    const residual = Math.abs(studentValueInReferenceUnit - input.reference.value);
    const error =
      input.reference.value === 0 ? residual : residual / Math.abs(input.reference.value);
    const valueMatch = error < input.reference.tolerance;
    const valueClose = !valueMatch && error < input.reference.tolerance * 10;

    return {
      parsed: true,
      value_si: studentValueInReferenceUnit,
      unit_si: referenceUnitLiteral,
      dimension_match: true,
      unit_exact_match: unitExactMatch,
      value_match: valueMatch,
      value_close: valueClose,
      signal: deriveSignal({ unitExactMatch, valueMatch, valueClose }),
    };
  } catch {
    return unparsed('unparseable');
  }
}

function deriveSignal(input: {
  unitExactMatch: boolean;
  valueMatch: boolean;
  valueClose: boolean;
}): SignalKindT | null {
  if (!input.unitExactMatch) return 'unit_mismatch_same_dimension';
  if (input.valueMatch) return null;
  if (input.valueClose) return 'numeric_close';
  return 'numeric_off';
}

function unparsed(signal: 'missing_unit' | 'unparseable'): AcceleratorResult {
  return {
    parsed: false,
    value_si: null,
    unit_si: null,
    dimension_match: false,
    unit_exact_match: false,
    value_match: false,
    value_close: false,
    signal,
  };
}
