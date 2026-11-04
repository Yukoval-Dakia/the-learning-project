// YUK-1770 steering — pure window/quote/exclusion helpers shared by the
// deterministic consumers (due-list deferral, expiry, selection, coach input).
// No IO: every caller passes learner-local (Asia/Shanghai) YYYY-MM-DD days.

import type { SteeringGoalDataT } from './schema/steering';

/** The steering-relevant projection of one active goal row. */
export interface ActiveSteeringGoal {
  goal_id: string;
  effective_from: string | null;
  effective_until: string | null;
  steering: SteeringGoalDataT;
}

/** Whole days from `today` (inclusive) until `until`; null when open-ended. */
export function steeringDaysLeft(until: string | null, today: string): number | null {
  if (until === null) return null;
  return Math.round((dayStartUtcMs(until) - dayStartUtcMs(today)) / DAY_MS);
}

/** Whole days until `from` starts (0 = starts today); null when no start. */
export function steeringStartsInDays(from: string | null, today: string): number | null {
  if (from === null) return null;
  return Math.round((dayStartUtcMs(from) - dayStartUtcMs(today)) / DAY_MS);
}

/**
 * Whether the window covers `today`: from ≤ today AND (no until OR today ≤ until).
 * A null from is treated as already-started (open start); expiry handles the tail.
 */
export function steeringWindowCoversToday(
  window: { effective_from: string | null; effective_until: string | null },
  today: string,
): boolean {
  if (window.effective_from !== null && window.effective_from > today) return false;
  if (window.effective_until !== null && window.effective_until < today) return false;
  return true;
}

// ─── Weekday + today line ─────────────────────────────────────────────────────
//
// Learner-local weekday for a calendar day. Formatting a bare YYYY-MM-DD as a
// wall-clock noon in Asia/Shanghai (fixed +8, no DST) pins the weekday regardless
// of the host's zone.

const SHANGHAI_WEEKDAY_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  weekday: 'short',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;

function dayStartUtcMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`) - BJT_OFFSET_MS;
}

/** Learner-local weekday label (周一…周日) for a YYYY-MM-DD day. */
export function learnerDayWeekday(day: string): string {
  return SHANGHAI_WEEKDAY_FORMATTER.format(new Date(dayStartUtcMs(day) + DAY_MS / 2));
}

/** 'YYYY-MM-DD（周X）' — the single agent-facing today/until line format. */
export function learnerDayWithWeekday(day: string): string {
  return `${day}（${learnerDayWeekday(day)}）`;
}

// ─── Verbatim quote check (D3 hard gate) ─────────────────────────────────────
//
// The quoted learner_words must appear in the learner's actual message. NFKC +
// whitespace collapse absorbs full/half-width and line-wrap noise without letting
// a paraphrase through: the collapsed quote must be a substring of the collapsed
// message.

export function normalizeForVerbatimCheck(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** True when `quote` appears verbatim (NFKC, whitespace-collapsed) in `message`. */
export function quoteAppearsInMessage(quote: string, message: string): boolean {
  const q = normalizeForVerbatimCheck(quote);
  if (q.length === 0) return false;
  return normalizeForVerbatimCheck(message).includes(q);
}

// ─── D4 exclusion set ─────────────────────────────────────────────────────────

/**
 * The deferred-review KC set for one subtractive steering goal: its excluded KCs
 * plus every excluded subject's KCs (caller pre-resolves subject → KC ids).
 * Pure union so the due-list deferral and the confirmation count share one truth.
 */
export function steeringExcludedKnowledgeIds(
  steering: Pick<SteeringGoalDataT, 'excluded_subject_ids' | 'excluded_knowledge_ids'>,
  subjectKnowledgeIds: Map<string, readonly string[]>,
): Set<string> {
  const out = new Set<string>(steering.excluded_knowledge_ids);
  for (const subjectId of steering.excluded_subject_ids) {
    for (const kc of subjectKnowledgeIds.get(subjectId) ?? []) out.add(kc);
  }
  return out;
}

/**
 * True when this steering goal carries any D4 exclusion (drives the one-time
 * cost statement and the deferral read).
 */
export function steeringIsSubtractive(steering: SteeringGoalDataT): boolean {
  return steering.excluded_subject_ids.length > 0 || steering.excluded_knowledge_ids.length > 0;
}
