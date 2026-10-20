// YUK-1622 — the model's daily_focus must not restate plan arithmetic.
//
// The TodayPlan numbers are computed from the due queue + budget, but the model
// still writes prose. A sentence such as "今天复习 30 题，约 60 分钟" would
// contradict the computed 7 / 14 on /today, so this guard removes only clauses
// that make a question-count, duration, or percentage claim. Bare numbers
// (dates, names, "第 3 题") are deliberately left alone.

const NUMBER = String.raw`(?:\d+(?:\.\d+)?|[零〇一二三四五六七八九十百千万两]+)`;

const PLAN_CLAIM_PATTERNS: readonly RegExp[] = [
  new RegExp(`${NUMBER}\\s*(?:道题|道|题)`),
  new RegExp(`${NUMBER}\\s*(?:分钟|小时|min(?:ute)?s?|hours?)`, 'i'),
  new RegExp(`${NUMBER}\\s*[%％]`),
  /百分之[零〇一二三四五六七八九十百千万两\d]+/,
  /半\s*(?:小时|分钟)/,
];

const ORDINAL_QUESTION = new RegExp(`第\\s*${NUMBER}\\s*(?:道题|道|题)`);
const CLAUSE = /[^，,；;。！？!?\n]+/g;

const SAFE_FALLBACK = '今天按到期队列开始复习。';

function hasPlanClaim(clause: string): boolean {
  // "第 3 题" is an ordinal, not a count claim.
  const withoutOrdinal = clause.replace(ORDINAL_QUESTION, '');
  return PLAN_CLAIM_PATTERNS.some((pattern) => pattern.test(withoutOrdinal));
}

/**
 * Drop clauses that claim a plan quantity. Safe text is returned unchanged;
 * if every clause was a claim, use a neutral fallback rather than inventing a
 * replacement number.
 */
export function guardDailyFocusClaims(text: string): string {
  const clauses = (text.match(CLAUSE) ?? []).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length === 0) return SAFE_FALLBACK;
  const kept = clauses.filter((clause) => !hasPlanClaim(clause));
  if (kept.length === clauses.length) return text.trim();
  if (kept.length === 0) return SAFE_FALLBACK;
  return `${kept.join('，')}。`;
}
