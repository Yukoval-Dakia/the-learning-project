// Session-summary contradiction guard (YUK-1783 / B5): the model's observation is
// published verbatim after the deterministic numeric prefix; the server flags
// clauses whose numbers contradict the session's computed stats.
//
// Same mechanism as the daily-focus plan check (YUK-1775): real counts ride the
// model input, contradictions surface as typed issues, nothing is rewritten or
// rejected. Claim parsing (number forms, clause splitting, ordinal/range
// handling) is shared via `@/core/number-claims`.
//
// Scope stays precision-over-recall:
//   - A single question claim in a clause with an outcome cue is compared to the
//     matching count (错→incorrect, 部分对→partial, 对→correct); with several
//     claims or no cue it is compared to the whole set of real counts, so a true
//     number that names a different quantity is never flagged.
//   - Percent claims are judged only when the clause names accuracy
//     (正确率/准确/得分率/通过率/正确); minutes only when the session duration
//     is known.
//   - Per-unit rates (每…) and clauses about another scope (本章/整章…) are
//     skipped outright — they are not claims about this session's totals.
// Issues are agent-facing information: they ride the experimental:session_summary
// event and never change the prose or the run outcome.

import { checkableClauses, collectClauseClaims, collectPercentClaims } from '@/core/number-claims';

export interface SessionSummaryFacts {
  /** Answer events on the session (judged + unjudged). */
  readonly total_reviewed: number;
  /** Answers carrying an effective verdict — the accuracy denominator. */
  readonly graded: number;
  readonly correct: number;
  readonly partial: number;
  readonly incorrect: number;
  /** The percent printed in numeric_summary; null when nothing was graded. */
  readonly correct_pct: number | null;
  readonly duration_min: number | null;
}

export type SessionSummaryIssue = {
  readonly kind: 'session_number_mismatch';
  readonly unit: 'questions' | 'minutes' | 'percent';
  readonly claimed: number;
  /** The real values the claim was checked against. */
  readonly expected: readonly number[];
  /** The clause the claim was read from, digits already normalized. */
  readonly clause: string;
};

const WRONG_CUE = /错|没对|未对|没答对|未答对|不正确|失败|丢分/;
const PARTIAL_CUE = /部分对|半对|部分正确/;
const RIGHT_CUE = /对|正确|答对|得分/;
const ACCURACY_CUE = /正确率|准确率|得分率|通过率|正确/;
const PER_UNIT = /每/;
const OTHER_SCOPE = /本章|本课|整章|全章|这一章|这一节/;

/**
 * Compare number claims in the model's observation against the session's
 * computed stats. The observation is returned to the caller untouched
 * regardless; the numeric prefix is never part of `text`.
 */
export function checkSessionSummaryClaims(
  text: string,
  facts: SessionSummaryFacts,
): SessionSummaryIssue[] {
  const issues: SessionSummaryIssue[] = [];
  const allQuestionCounts = [
    ...new Set([facts.total_reviewed, facts.graded, facts.correct, facts.partial, facts.incorrect]),
  ];
  for (const clause of checkableClauses(text)) {
    if (PER_UNIT.test(clause) || OTHER_SCOPE.test(clause)) continue;
    const { questionClaims, minuteClaims } = collectClauseClaims(clause);

    const hasWrongCue = WRONG_CUE.test(clause);
    const questionExpected =
      questionClaims.size > 1
        ? allQuestionCounts
        : hasWrongCue
          ? [facts.incorrect]
          : PARTIAL_CUE.test(clause)
            ? [facts.partial]
            : RIGHT_CUE.test(clause)
              ? [facts.correct]
              : allQuestionCounts;
    for (const claimed of questionClaims) {
      if (!questionExpected.includes(claimed)) {
        issues.push({
          kind: 'session_number_mismatch',
          unit: 'questions',
          claimed,
          expected: questionExpected,
          clause,
        });
      }
    }
    if (facts.duration_min !== null) {
      for (const claimed of minuteClaims) {
        if (claimed !== facts.duration_min) {
          issues.push({
            kind: 'session_number_mismatch',
            unit: 'minutes',
            claimed,
            expected: [facts.duration_min],
            clause,
          });
        }
      }
    }
    if (facts.correct_pct !== null && ACCURACY_CUE.test(clause)) {
      const percentClaims = new Set<number>();
      collectPercentClaims(clause, percentClaims);
      for (const claimed of percentClaims) {
        if (claimed !== facts.correct_pct) {
          issues.push({
            kind: 'session_number_mismatch',
            unit: 'percent',
            claimed,
            expected: [facts.correct_pct],
            clause,
          });
        }
      }
    }
  }
  return issues;
}
