// The model's daily_focus prose is published verbatim; the server flags clauses
// about today's plan whose numbers contradict the computed plan.
//
// Scope is deliberately narrow — precision over recall:
//   - Only sentences that explicitly address today's arrangement (今天/今日/本次/
//     这次/今晚) are checked at all; within them, clauses naming a past frame
//     (昨天/上周/之前/…) are skipped so "昨天…，今天…" still judges the today half.
//     A number whose sentence has no today frame is never reported — when in
//     doubt, don't report.
//   - Question claims compare only against the plan question count, minute claims
//     only against the plan minutes. Nothing else in the run input is a truth
//     source, so real numbers the model observed through its tools (e.g.
//     "昨天错了 7 道题") are never judged.
//   - A percentage claim in a checked clause is reported as unsupported_percentage:
//     the prompt forbids attaching percentages to plan or weak-point statements.
//   - A range claim (3-5 题, 三到五题) has both endpoints compared — a range is not
//     the plan number, so it passes only when every endpoint equals the plan value.
// Issues are written to the scan event's plan_issues and fed back into the next
// Coach run's input so the model rephrases; they are agent-facing information, not
// an alert, and never change the prose or the run outcome.
//
// Claim reading (number parsing, clause splitting, ordinal/range/half-hour
// handling) is shared with the session-summary guard in `@/core/number-claims`.

import {
  PAST_FRAME,
  PERCENT_CLAIM,
  collectClauseClaims,
  normalizeDigits,
} from '@/core/number-claims';

export interface DailyFocusPlanNumbers {
  readonly questionCount: number;
  readonly minutes: number;
}

export type DailyFocusPlanIssue =
  | {
      readonly kind: 'plan_number_mismatch';
      readonly unit: 'questions' | 'minutes';
      readonly claimed: number;
      readonly expected: number;
      /** The clause the claim was read from, digits already normalized. */
      readonly clause: string;
    }
  | {
      readonly kind: 'unsupported_percentage';
      /** The matched percentage text, e.g. "50%" or "百分之五十". */
      readonly claimed: string;
      readonly clause: string;
    };

// A sentence must name today's arrangement for its clauses to be checked at all.
const TODAY_FRAME = /今天|今日|本次|这次|今晚/;

/**
 * Compare number claims about today's plan against the plan's own `questionCount` /
 * `minutes`. Sentences without an explicit today frame are skipped entirely; inside
 * a today sentence, clauses naming a past frame are skipped. The prose is returned
 * to the caller untouched regardless.
 */
export function checkDailyFocusPlanClaims(
  text: string,
  plan: DailyFocusPlanNumbers,
): DailyFocusPlanIssue[] {
  const issues: DailyFocusPlanIssue[] = [];
  for (const rawSentence of normalizeDigits(text).split(/[。！？!?；;\n]+/)) {
    const sentence = rawSentence.trim();
    if (!sentence || !TODAY_FRAME.test(sentence)) continue;
    for (const rawClause of sentence.split(/[，,、]+/)) {
      const clause = rawClause.trim();
      if (!clause || PAST_FRAME.test(clause)) continue;

      const { questionClaims, minuteClaims } = collectClauseClaims(clause);

      for (const match of clause.matchAll(PERCENT_CLAIM)) {
        issues.push({
          kind: 'unsupported_percentage',
          claimed: match[0].trim(),
          clause,
        });
      }
      for (const claimed of questionClaims) {
        if (claimed !== plan.questionCount) {
          issues.push({
            kind: 'plan_number_mismatch',
            unit: 'questions',
            claimed,
            expected: plan.questionCount,
            clause,
          });
        }
      }
      for (const claimed of minuteClaims) {
        if (claimed !== plan.minutes) {
          issues.push({
            kind: 'plan_number_mismatch',
            unit: 'minutes',
            claimed,
            expected: plan.minutes,
            clause,
          });
        }
      }
    }
  }
  return issues;
}
