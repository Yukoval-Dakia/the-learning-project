import type { JudgeResultV2T } from '@/core/schema/capability';

export interface VerdictRow {
  signal_idx: number;
  signal_text: string;
  verdict: 'correct' | 'partial' | 'wrong' | 'skipped';
  comment: string;
}

const VERDICT_LABEL: Record<VerdictRow['verdict'], string> = {
  correct: '正确',
  partial: '部分',
  wrong: '错误',
  skipped: '未答',
};

const ROUTE_LABEL: Record<string, string> = {
  exact: 'exact 严格比对',
  keyword: 'keyword 关键词',
  semantic: 'semantic 语义判分',
  steps: 'steps@1 视觉判分',
};

export function judgeRouteLabel(capabilityId: string): string {
  return ROUTE_LABEL[capabilityId] ?? capabilityId;
}

export function verdictLabel(verdict: VerdictRow['verdict']): string {
  return VERDICT_LABEL[verdict];
}

/**
 * Build verdict rows by pairing expected_signals (from reference solution)
 * with signal_verdicts (from LLM output). Both arrays must have equal length —
 * judge runtime guarantees this (runStepsJudge length-mismatch guard).
 */
export function buildVerdictRows(
  expectedSignals: string[],
  signalVerdicts: Array<{
    signal_idx: number;
    verdict: VerdictRow['verdict'];
    comment: string;
  }>,
): VerdictRow[] {
  return expectedSignals.map((sig, idx) => {
    const sv = signalVerdicts.find((v) => v.signal_idx === idx);
    return {
      signal_idx: idx,
      signal_text: sig,
      verdict: sv?.verdict ?? 'skipped',
      comment: sv?.comment ?? '',
    };
  });
}

/**
 * Best-effort extract of evidence display fields. JudgeResultV2.evidence_json is
 * Record<string, unknown>; this helper narrows to the steps@1 shape.
 */
export interface StepsEvidence {
  signal_verdicts?: Array<{
    signal_idx: number;
    verdict: VerdictRow['verdict'];
    comment: string;
  }>;
  extracted_final_answer?: string;
  step_score_raw?: number | null;
  step_weight?: number;
  accelerator?: string;
}

export function extractStepsEvidence(result: JudgeResultV2T): StepsEvidence {
  const e = result.evidence_json as StepsEvidence;
  return {
    signal_verdicts: Array.isArray(e?.signal_verdicts) ? e.signal_verdicts : undefined,
    extracted_final_answer:
      typeof e?.extracted_final_answer === 'string' ? e.extracted_final_answer : undefined,
    step_score_raw: typeof e?.step_score_raw === 'number' ? e.step_score_raw : null,
    step_weight: typeof e?.step_weight === 'number' ? e.step_weight : undefined,
    accelerator: typeof e?.accelerator === 'string' ? e.accelerator : undefined,
  };
}
