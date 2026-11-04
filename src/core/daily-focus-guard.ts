// YUK-1622 → YUK-1775 — the model's daily_focus prose is published verbatim; the
// server only flags numeric claims that contradict the computed plan.
//
// Plan numbers come from the due queue and budget (`daily-review-plan.ts`). Instead of
// deleting number-bearing clauses, we extract "N 题 / N 分钟 / N 小时" claims and compare
// each against the server truth set. A claim matching any server value passes; one that
// contradicts all of them produces a typed `number_mismatch` issue for the degraded
// channel. Prose itself is never rewritten and there is no fallback sentence.

export interface DailyFocusNumberIssue {
  readonly kind: 'number_mismatch';
  readonly unit: 'questions' | 'minutes';
  readonly claimed: number;
  /** Every server-computed value the claim could legitimately restate. */
  readonly actual: readonly number[];
}

export interface DailyFocusActuals {
  readonly questionCounts: readonly number[];
  readonly minutes: readonly number[];
}

const NUMBER = String.raw`(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百千万两]+)`;

const QUESTION_CLAIM = new RegExp(`(${NUMBER})\\s*(?:道题|道|题)`, 'g');
const MINUTE_CLAIM = new RegExp(`(${NUMBER})\\s*(?:分钟|min(?:ute)?s?)`, 'gi');
const HOUR_CLAIM = new RegExp(`(${NUMBER})\\s*(?:小时|hours?)`, 'gi');
const HALF_HOUR = /半\s*个?小时/g;
// "第 3 题" is an ordinal reference, not a count claim.
const ORDINAL_QUESTION = new RegExp(`第\\s*${NUMBER}\\s*(?:道题|道|题)`, 'g');

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

function collectClaims(text: string, pattern: RegExp, scale: number, into: Set<number>): void {
  for (const match of text.matchAll(pattern)) {
    const value = parseNumber(match[1]);
    if (value !== null && value > 0) into.add(value * scale);
  }
}

/**
 * Compare number claims in `text` against the server-computed plan values. Claims that
 * contradict every server value yield one `number_mismatch` issue each; the prose is
 * returned to the caller untouched regardless.
 */
export function checkDailyFocusNumbers(
  text: string,
  actuals: DailyFocusActuals,
): DailyFocusNumberIssue[] {
  const withoutOrdinals = text.replace(ORDINAL_QUESTION, '');
  const questionClaims = new Set<number>();
  collectClaims(withoutOrdinals, QUESTION_CLAIM, 1, questionClaims);
  const minuteClaims = new Set<number>();
  collectClaims(withoutOrdinals, MINUTE_CLAIM, 1, minuteClaims);
  collectClaims(withoutOrdinals, HOUR_CLAIM, 60, minuteClaims);
  for (const _ of withoutOrdinals.matchAll(HALF_HOUR)) minuteClaims.add(30);

  const issues: DailyFocusNumberIssue[] = [];
  for (const claimed of questionClaims) {
    if (!actuals.questionCounts.includes(claimed)) {
      issues.push({
        kind: 'number_mismatch',
        unit: 'questions',
        claimed,
        actual: actuals.questionCounts,
      });
    }
  }
  for (const claimed of minuteClaims) {
    if (!actuals.minutes.includes(claimed)) {
      issues.push({
        kind: 'number_mismatch',
        unit: 'minutes',
        claimed,
        actual: actuals.minutes,
      });
    }
  }
  return issues;
}
