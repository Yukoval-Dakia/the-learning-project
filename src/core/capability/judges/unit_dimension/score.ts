import type { JudgeResultV2T } from '@/core/schema/capability';

import type { AcceleratorResult } from './accelerator';
import type { LlmFallbackOutputT, SignalKindT } from './types';

const CAPABILITY_REF = { id: 'unit_dimension', version: '1.0.0' };

export function composeScore(input: {
  accelerator: AcceleratorResult;
  fallback?: LlmFallbackOutputT;
  reference?: { value: number; unit: string; tolerance: number };
  evidence: Record<string, unknown>;
}): JudgeResultV2T {
  const { accelerator, fallback, reference, evidence } = input;

  if (accelerator.parsed) {
    if (!accelerator.dimension_match) {
      return mkIncorrect('dimension_mismatch', 0.85, '量纲错', evidence);
    }
    if (!accelerator.unit_exact_match) {
      return mkPartial(
        0.4,
        'unit_mismatch_same_dimension',
        0.85,
        '单位写错（量纲对，单位非 SI 形式或同 family 异单位）',
        evidence,
      );
    }
    if (accelerator.value_match) {
      return mkCorrect(1.0, 0.95, '单位 + 数值全对', evidence);
    }
    if (accelerator.value_close) {
      return mkPartial(
        0.7,
        'numeric_close',
        0.9,
        `单位对，${formatCloseBand(reference)}`,
        evidence,
      );
    }
    return mkPartial(0.3, 'numeric_off', 0.85, `单位对，${formatOffBand(reference)}`, evidence);
  }

  if (accelerator.signal === 'missing_unit') {
    return mkIncorrect('missing_unit', 0.8, '只有数值，缺单位', evidence);
  }

  if (!fallback) {
    return unsupported('accelerator unparseable, fallback not invoked', evidence);
  }
  if (fallback.equivalent_to_reference) {
    return mkCorrect(1.0, fallback.parser_confidence, 'LLM fallback 判等价 (含中文 / 复合形式)', {
      ...evidence,
      fallback,
    });
  }
  if (fallback.dimension_mismatch_reason) {
    return mkIncorrect(
      'dimension_mismatch',
      fallback.parser_confidence,
      `LLM fallback 判量纲不一致: ${fallback.dimension_mismatch_reason}`,
      { ...evidence, fallback },
    );
  }
  if (fallback.student_value_si !== null && fallback.student_unit_si !== null && reference) {
    const diff = Math.abs(fallback.student_value_si - reference.value);
    const error = reference.value === 0 ? diff : diff / Math.abs(reference.value);
    const valueMatch = error <= reference.tolerance;
    const valueClose = !valueMatch && error < reference.tolerance * 10;
    const unitExactMatch = fallback.student_unit_si === reference.unit;

    if (!unitExactMatch) {
      return mkPartial(
        0.4,
        'unit_mismatch_same_dimension',
        fallback.parser_confidence,
        `LLM fallback 解析单位 ${fallback.student_unit_si} ≠ ref ${reference.unit}`,
        { ...evidence, fallback },
      );
    }
    if (valueMatch) {
      return mkCorrect(1.0, fallback.parser_confidence, 'LLM fallback 解析后单位对、数值在容差内', {
        ...evidence,
        fallback,
      });
    }
    if (valueClose) {
      return mkPartial(
        0.7,
        'numeric_close',
        fallback.parser_confidence,
        `LLM fallback 解析后${formatCloseBand(reference)}`,
        { ...evidence, fallback },
      );
    }
    return mkPartial(
      0.3,
      'numeric_off',
      fallback.parser_confidence,
      `LLM fallback 解析后${formatOffBand(reference)}`,
      { ...evidence, fallback },
    );
  }

  return unsupported('accelerator + LLM fallback 均不能解析', { ...evidence, fallback });
}

function formatCloseBand(reference?: { value: number; tolerance: number }): string {
  if (!reference) return '数值偏差超过容差但仍接近';
  const lower = formatErrorThreshold(reference.tolerance, reference.value);
  const upper = formatErrorThreshold(reference.tolerance * 10, reference.value);
  const mode = reference.value === 0 ? '绝对偏差' : '相对偏差';
  return `${mode}在 ${lower}-${upper}`;
}

function formatOffBand(reference?: { value: number; tolerance: number }): string {
  if (!reference) return '数值偏差超过接近阈值';
  const upper = formatErrorThreshold(reference.tolerance * 10, reference.value);
  const mode = reference.value === 0 ? '绝对偏差' : '相对偏差';
  return `${mode} ≥ ${upper}`;
}

function formatErrorThreshold(value: number, referenceValue: number): string {
  if (referenceValue === 0) return formatNumber(value);
  return `${formatNumber(value * 100)}%`;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(6)));
}

function mkCorrect(
  score: number,
  confidence: number,
  feedback_md: string,
  evidence: Record<string, unknown>,
): JudgeResultV2T {
  return {
    coarse_outcome: 'correct',
    score,
    score_meaning: 'unit_dimension_v1',
    confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md,
    evidence_json: { ...evidence, signal: null },
  };
}

function mkPartial(
  score: number,
  signal: SignalKindT,
  confidence: number,
  feedback_md: string,
  evidence: Record<string, unknown>,
): JudgeResultV2T {
  return {
    coarse_outcome: 'partial',
    score,
    score_meaning: 'unit_dimension_v1',
    confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md,
    evidence_json: { ...evidence, signal },
  };
}

function mkIncorrect(
  signal: SignalKindT,
  confidence: number,
  feedback_md: string,
  evidence: Record<string, unknown>,
): JudgeResultV2T {
  return {
    coarse_outcome: 'incorrect',
    score: 0,
    score_meaning: 'unit_dimension_v1',
    confidence,
    capability_ref: CAPABILITY_REF,
    feedback_md,
    evidence_json: { ...evidence, signal },
  };
}

function unsupported(reason: string, evidence: Record<string, unknown>): JudgeResultV2T {
  return {
    coarse_outcome: 'unsupported',
    score: null,
    score_meaning: 'unit_dimension_v1',
    confidence: 0,
    capability_ref: CAPABILITY_REF,
    feedback_md: reason,
    evidence_json: evidence,
  };
}
