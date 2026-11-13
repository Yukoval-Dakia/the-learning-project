// Yesterday's coach focuses, and the draft adjustment that puts a skip first.
// Absence is a skip only when the answer scan finished; this module does not read.

import type { CoachPlanDraftT } from '@/core/schema/coach';

export type YesterdayFocusSettlement =
  | { kind: 'not_practiced' }
  | { kind: 'practiced'; correct: number; wrong: number; partial: number }
  | { kind: 'unknown' };

export interface YesterdayFocusOutcome {
  knowledge_id: string;
  knowledge_name: string | null;
  settlement: YesterdayFocusSettlement;
}

export interface YesterdayPlanOutcome {
  plan_day: string;
  planned_at: string;
  focuses: YesterdayFocusOutcome[];
}

/** Matches TodayPlan.daily_focus max length; a longer string fails compose. */
const DAILY_FOCUS_MAX = 280;

function fitDailyFocus(clause: string, rest: string): string {
  const lead = clause.length > DAILY_FOCUS_MAX ? clause.slice(0, DAILY_FOCUS_MAX) : clause;
  const room = DAILY_FOCUS_MAX - lead.length;
  if (room <= 0) return lead;
  return `${lead}${rest.slice(0, room)}`;
}

/** Skipped yesterday focuses lead knowledge_focus, and daily_focus names the skip. */
export function rankSkippedYesterdayFocus(
  draft: CoachPlanDraftT,
  outcome: YesterdayPlanOutcome | null,
): CoachPlanDraftT {
  if (!outcome) return draft;
  const skipped = outcome.focuses.filter((focus) => focus.settlement.kind === 'not_practiced');
  if (skipped.length === 0) return draft;
  const skippedIds = skipped.map((focus) => focus.knowledge_id);
  const skippedSet = new Set(skippedIds);
  const names = skipped.map((focus) => focus.knowledge_name ?? focus.knowledge_id);
  const clause = `昨天跳过了${names.join('、')}。`;
  return {
    ...draft,
    daily_focus: draft.daily_focus.includes('昨天跳过了')
      ? draft.daily_focus
      : fitDailyFocus(clause, draft.daily_focus),
    review_session_proposal: {
      ...draft.review_session_proposal,
      knowledge_focus: [
        ...skippedIds,
        ...draft.review_session_proposal.knowledge_focus.filter((id) => !skippedSet.has(id)),
      ],
    },
  };
}
