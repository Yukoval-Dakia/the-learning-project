// YUK-1622 → YUK-1775 — the model's daily_focus prose is published verbatim; the
// server only flags numeric claims that contradict the computed plan.
//
// The model contract is "numbers are read from the injected context". So the truth set
// is every finite number leaf in that context (`collectSuppliedNumbers`): plan count,
// due count, subject weights, minutes, budget, derived stats like weak-point failure
// counts. A "N 题 / N 分钟" claim matching any supplied number is a legitimate
// restatement — including real narrative stats like "昨天错了 5 道题". A claim matching
// none is either a plan contradiction or an unsourced number, and yields a typed
// `number_mismatch` issue for the degraded channel. Prose is never rewritten and there
// is no fallback sentence.

export interface DailyFocusNumberIssue {
  readonly kind: 'number_mismatch';
  readonly unit: 'questions' | 'minutes';
  readonly claimed: number;
  /** Sorted server-supplied values the claim could legitimately restate. */
  readonly actual: readonly number[];
}

const NUMBER = String.raw`(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百千万两]+)`;

const QUESTION_CLAIM = new RegExp(`(${NUMBER})\\s*(?:道题|道|题)`, 'g');
const MINUTE_CLAIM = new RegExp(`(${NUMBER})\\s*(?:分钟|min(?:ute)?s?)`, 'gi');
const HOUR_CLAIM = new RegExp(`(${NUMBER})\\s*(?:小时|hours?)`, 'gi');
// "一个半小时" claims 90; consumed before the bare-半 hour pass so 半 isn't double-read.
const NUM_HALF_HOUR = new RegExp(`(${NUMBER})\\s*个?\\s*半\\s*个?\\s*小时`, 'g');
const HALF_HOUR = /半\s*个?\s*小时/g;
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
 * Every finite number leaf in a JSON-like value. The coach input's supplied numbers are
 * the only values the model may legitimately restate in prose; strings (ids, ISO dates)
 * contribute nothing.
 */
export function collectSuppliedNumbers(value: unknown, into = new Set<number>()): Set<number> {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) into.add(value);
    return into;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSuppliedNumbers(item, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectSuppliedNumbers(item, into);
  }
  return into;
}

/**
 * Compare number claims in `text` against the server-supplied number set. Claims that
 * match no supplied value yield one `number_mismatch` issue each; the prose is returned
 * to the caller untouched regardless.
 */
export function checkDailyFocusNumbers(
  text: string,
  supplied: ReadonlySet<number>,
): DailyFocusNumberIssue[] {
  const questionClaims = new Set<number>();
  const minuteClaims = new Set<number>();
  const withoutNumHalfHour = text
    .replace(ORDINAL_QUESTION, '')
    .replace(NUM_HALF_HOUR, (_match, token: string) => {
      const value = parseNumber(token);
      if (value !== null && value > 0) minuteClaims.add(value * 60 + 30);
      return '';
    });
  collectClaims(withoutNumHalfHour, QUESTION_CLAIM, 1, questionClaims);
  collectClaims(withoutNumHalfHour, MINUTE_CLAIM, 1, minuteClaims);
  collectClaims(withoutNumHalfHour, HOUR_CLAIM, 60, minuteClaims);
  for (const _ of withoutNumHalfHour.matchAll(HALF_HOUR)) minuteClaims.add(30);

  const actual = [...supplied].sort((a, b) => a - b);
  const issues: DailyFocusNumberIssue[] = [];
  for (const claimed of questionClaims) {
    if (!supplied.has(claimed)) {
      issues.push({ kind: 'number_mismatch', unit: 'questions', claimed, actual });
    }
  }
  for (const claimed of minuteClaims) {
    if (!supplied.has(claimed)) {
      issues.push({ kind: 'number_mismatch', unit: 'minutes', claimed, actual });
    }
  }
  return issues;
}
