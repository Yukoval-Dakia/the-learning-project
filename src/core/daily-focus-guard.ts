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

const NUMBER = String.raw`(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百千万两]+)`;
const RANGE_JOIN = '(?:[-–—~～]|至|到)';

const QUESTION_RANGE = new RegExp(
  `(${NUMBER})\\s*${RANGE_JOIN}\\s*(${NUMBER})\\s*(?:道题|道|题)`,
  'g',
);
const MINUTE_RANGE = new RegExp(
  `(${NUMBER})\\s*${RANGE_JOIN}\\s*(${NUMBER})\\s*(?:分钟|min(?:ute)?s?)`,
  'gi',
);
const HOUR_RANGE = new RegExp(
  `(${NUMBER})\\s*${RANGE_JOIN}\\s*(${NUMBER})\\s*(?:小时|hours?)`,
  'gi',
);
const QUESTION_CLAIM = new RegExp(`(${NUMBER})\\s*(?:道题|道|题)`, 'g');
const MINUTE_CLAIM = new RegExp(`(${NUMBER})\\s*(?:分钟|min(?:ute)?s?)`, 'gi');
const HOUR_CLAIM = new RegExp(`(${NUMBER})\\s*(?:小时|hours?)`, 'gi');
const PERCENT_CLAIM = new RegExp(`(?:${NUMBER}\\s*[%％]|百分之\\s*${NUMBER})`, 'g');
// "一个半小时" claims 90; consumed before the bare-半 hour pass so 半 isn't double-read.
const NUM_HALF_HOUR = new RegExp(`(${NUMBER})\\s*个?\\s*半\\s*个?\\s*小时`, 'g');
const HALF_HOUR = /半\s*个?\s*小时/g;
// "第 3 题" is an ordinal reference, not a count claim.
const ORDINAL_QUESTION = new RegExp(`第\\s*${NUMBER}\\s*(?:道题|道|题)`, 'g');

// A sentence must name today's arrangement for its clauses to be checked at all.
const TODAY_FRAME = /今天|今日|本次|这次|今晚/;
// A past frame makes every number in the clause ambiguous — skip that clause.
const PAST_FRAME = /昨天|昨日|前天|上周|之前|以前|上次|过去|曾经|早先/;

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

function parseChineseNumber(text: string): number | null {
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const ch of text) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch];
      seen = true;
    } else if (ch in CN_UNITS) {
      seen = true;
      const unit = CN_UNITS[ch];
      if (unit >= 10000) {
        total += (section + digit) * unit;
        section = 0;
      } else {
        section += (digit || 1) * unit;
      }
      digit = 0;
    } else {
      return null;
    }
  }
  if (!seen) return null;
  return total + section + digit;
}

function parseNumber(token: string): number | null {
  if (/^\d/.test(token)) {
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
  }
  return parseChineseNumber(token);
}

// Full-width digits read as ordinary digits; the rest of the text is untouched.
function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10));
}

function collectClaims(text: string, pattern: RegExp, scale: number, into: Set<number>): void {
  for (const match of text.matchAll(pattern)) {
    const value = parseNumber(match[1]);
    if (value !== null && value >= 0) into.add(value * scale);
  }
}

function collectRangeClaims(text: string, pattern: RegExp, scale: number, into: Set<number>): void {
  for (const match of text.matchAll(pattern)) {
    for (const token of [match[1], match[2]]) {
      const value = parseNumber(token);
      if (value !== null && value >= 0) into.add(value * scale);
    }
  }
}

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

      const questionClaims = new Set<number>();
      const minuteClaims = new Set<number>();
      // Ordinal references and "N 个半小时" phrasing are consumed before the plain
      // question/hour passes so they are not double-read.
      const withoutNumHalfHour = clause
        .replace(ORDINAL_QUESTION, '')
        .replace(NUM_HALF_HOUR, (_match, token: string) => {
          const value = parseNumber(token);
          if (value !== null && value >= 0) minuteClaims.add(value * 60 + 30);
          return '';
        });
      collectRangeClaims(withoutNumHalfHour, QUESTION_RANGE, 1, questionClaims);
      collectRangeClaims(withoutNumHalfHour, MINUTE_RANGE, 1, minuteClaims);
      collectRangeClaims(withoutNumHalfHour, HOUR_RANGE, 60, minuteClaims);
      collectClaims(withoutNumHalfHour, QUESTION_CLAIM, 1, questionClaims);
      collectClaims(withoutNumHalfHour, MINUTE_CLAIM, 1, minuteClaims);
      collectClaims(withoutNumHalfHour, HOUR_CLAIM, 60, minuteClaims);
      for (const _ of withoutNumHalfHour.matchAll(HALF_HOUR)) minuteClaims.add(30);

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
