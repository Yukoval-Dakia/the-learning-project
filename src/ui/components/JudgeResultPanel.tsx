'use client';

import type { JudgeResultV2T } from '@/core/schema/capability';
import {
  buildVerdictRows,
  extractStepsEvidence,
  judgeRouteLabel,
  verdictLabel,
} from '@/ui/lib/judge-result-format';
import { MathMarkdown } from '@/ui/lib/math-markdown';

export interface JudgeResultPanelProps {
  result: JudgeResultV2T;
  /** Expected signals from reference_solution (rubric_json) — for zipping with signal_verdicts. */
  expectedSignals: string[];
  /** Trigger appeal write. Provided by parent (review page). */
  onAppeal?: () => void;
  /** Whether appeal button shows; disabled if already appealed in this session. */
  appealable?: boolean;
  /** Subject's renderConfig.notation — passed through to MathMarkdown. */
  notation?: 'latex' | 'wenyan' | 'plaintext' | 'code';
}

const OUTCOME_TONE: Record<JudgeResultV2T['coarse_outcome'], string> = {
  correct: 'judge-tone-correct',
  partial: 'judge-tone-partial',
  incorrect: 'judge-tone-incorrect',
  unsupported: 'judge-tone-unsupported',
};

const OUTCOME_LABEL: Record<JudgeResultV2T['coarse_outcome'], string> = {
  correct: '完整正确',
  partial: '部分正确',
  incorrect: '错误',
  unsupported: '无法判分',
};

/**
 * M2.3: partial credit display + judge route reason + appeal button.
 *
 * Only mount this for steps@1 route — exact/keyword/semantic have simpler
 * displays handled by surrounding feedback UI. Parent gates the mount.
 */
export function JudgeResultPanel({
  result,
  expectedSignals,
  onAppeal,
  appealable = true,
  notation,
}: JudgeResultPanelProps) {
  const evidence = extractStepsEvidence(result);
  const verdictRows =
    evidence.signal_verdicts && expectedSignals.length > 0
      ? buildVerdictRows(expectedSignals, evidence.signal_verdicts)
      : [];
  const isStepsRoute = result.capability_ref.id === 'steps';
  const isAccelerator = evidence.accelerator === 'final_answer_match';

  return (
    <div className="judge-result-panel">
      <div className="judge-result-panel__header">
        <span className={`judge-result-panel__outcome ${OUTCOME_TONE[result.coarse_outcome]}`}>
          {OUTCOME_LABEL[result.coarse_outcome]}
        </span>
        {result.score !== null && (
          <span className="judge-result-panel__score">{(result.score * 100).toFixed(0)}%</span>
        )}
        <span className="judge-result-panel__route">
          由 {judgeRouteLabel(result.capability_ref.id)} 判分
          {isAccelerator && ' (加速：最终答案匹配)'}
        </span>
      </div>

      {result.feedback_md && (
        <MathMarkdown notation={notation} className="judge-result-panel__feedback">
          {result.feedback_md}
        </MathMarkdown>
      )}

      {isStepsRoute && verdictRows.length > 0 && (
        <ol className="judge-result-panel__verdicts">
          {verdictRows.map((row) => (
            <li key={row.signal_idx} className={`verdict-row verdict-${row.verdict}`}>
              <span className="verdict-row__label">{verdictLabel(row.verdict)}</span>
              <MathMarkdown notation={notation} className="verdict-row__signal">
                {row.signal_text}
              </MathMarkdown>
              {row.comment && (
                <MathMarkdown notation={notation} className="verdict-row__comment">
                  {row.comment}
                </MathMarkdown>
              )}
            </li>
          ))}
        </ol>
      )}

      {isStepsRoute && evidence.extracted_final_answer && (
        <div className="judge-result-panel__extracted">
          <span className="label-mono">提取的最终答案</span>
          <MathMarkdown notation={notation}>{evidence.extracted_final_answer}</MathMarkdown>
        </div>
      )}

      {appealable && onAppeal && (
        <button type="button" className="judge-result-panel__appeal" onClick={onAppeal}>
          申诉判分
        </button>
      )}
    </div>
  );
}
