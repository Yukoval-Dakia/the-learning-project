// Shared numeric-claim machinery for prose contradiction guards. Two consumers:
// `daily-focus-guard` (today-plan numbers vs Coach prose) and the session-summary
// guard (session stats vs the model's observation). Extraction in YUK-1783 keeps
// both checks on one parser — divergence between the two would mean one guard
// reads numbers the other cannot.
//
// Scope of every consumer stays precision-over-recall: a claim is judged only
// when its clause context makes the intended quantity unambiguous.

const NUMBER = String.raw`(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百千万两]+)`;
const RANGE_JOIN = '(?:[-–—~～]|至|到)';

export const QUESTION_RANGE = new RegExp(
  `(${NUMBER})\\s*${RANGE_JOIN}\\s*(${NUMBER})\\s*(?:道题|道|题)`,
  'g',
);
export const MINUTE_RANGE = new RegExp(
  `(${NUMBER})\\s*${RANGE_JOIN}\\s*(${NUMBER})\\s*(?:分钟|min(?:ute)?s?)`,
  'gi',
);
export const HOUR_RANGE = new RegExp(
  `(${NUMBER})\\s*${RANGE_JOIN}\\s*(${NUMBER})\\s*(?:小时|hours?)`,
  'gi',
);
export const QUESTION_CLAIM = new RegExp(`(${NUMBER})\\s*(?:道题|道|题)`, 'g');
export const MINUTE_CLAIM = new RegExp(`(${NUMBER})\\s*(?:分钟|min(?:ute)?s?)`, 'gi');
export const HOUR_CLAIM = new RegExp(`(${NUMBER})\\s*(?:小时|hours?)`, 'gi');
export const PERCENT_CLAIM = new RegExp(`(${NUMBER})\\s*[%％]|百分之\\s*(${NUMBER})`, 'g');
// "一个半小时" claims 90; consumed before the bare-半 hour pass so 半 isn't double-read.
export const NUM_HALF_HOUR = new RegExp(`(${NUMBER})\\s*个?\\s*半\\s*个?\\s*小时`, 'g');
export const HALF_HOUR = /半\s*个?\s*小时/g;
// "第 3 题" is an ordinal reference, not a count claim.
export const ORDINAL_QUESTION = new RegExp(`第\\s*${NUMBER}\\s*(?:道题|道|题)`, 'g');

// A past frame makes every number in the clause ambiguous — skip that clause.
export const PAST_FRAME = /昨天|昨日|前天|上周|之前|以前|上次|过去|曾经|早先/;

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

export function parseClaimNumber(token: string): number | null {
  if (/^\d/.test(token)) {
    const value = Number(token);
    return Number.isFinite(value) ? value : null;
  }
  return parseChineseNumber(token);
}

// Full-width digits read as ordinary digits; the rest of the text is untouched.
export function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10));
}

export function collectClaims(
  text: string,
  pattern: RegExp,
  scale: number,
  into: Set<number>,
): void {
  for (const match of text.matchAll(pattern)) {
    const value = parseClaimNumber(match[1]);
    if (value !== null && value >= 0) into.add(value * scale);
  }
}

export function collectRangeClaims(
  text: string,
  pattern: RegExp,
  scale: number,
  into: Set<number>,
): void {
  for (const match of text.matchAll(pattern)) {
    for (const token of [match[1], match[2]]) {
      const value = parseClaimNumber(token);
      if (value !== null && value >= 0) into.add(value * scale);
    }
  }
}

// Both "50%" and "百分之五十" read as 50. Either branch captures a number.
export function collectPercentClaims(text: string, into: Set<number>): void {
  for (const match of text.matchAll(PERCENT_CLAIM)) {
    const value = parseClaimNumber(match[1] ?? match[2]);
    if (value !== null && value >= 0) into.add(value);
  }
}

/** Question + minute claims in one clause, with ordinals and half-hours consumed first. */
export function collectClauseClaims(clause: string): {
  questionClaims: Set<number>;
  minuteClaims: Set<number>;
} {
  const questionClaims = new Set<number>();
  const minuteClaims = new Set<number>();
  // Ordinal references and "N 个半小时" phrasing are consumed before the plain
  // question/hour passes so they are not double-read.
  const withoutNumHalfHour = clause
    .replace(ORDINAL_QUESTION, '')
    .replace(NUM_HALF_HOUR, (_match, token: string) => {
      const value = parseClaimNumber(token);
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
  return { questionClaims, minuteClaims };
}

/** Digits normalized, split on sentence marks then clause marks; past-frame clauses dropped. */
export function* checkableClauses(text: string): Generator<string> {
  for (const rawSentence of normalizeDigits(text).split(/[。！？!?；;\n]+/)) {
    const sentence = rawSentence.trim();
    if (!sentence) continue;
    for (const rawClause of sentence.split(/[，,、]+/)) {
      const clause = rawClause.trim();
      if (!clause || PAST_FRAME.test(clause)) continue;
      yield clause;
    }
  }
}
