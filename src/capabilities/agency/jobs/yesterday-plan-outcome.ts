// Reads yesterday's coach knowledge_focus and scores each point from settled
// answers. Absence is a skip only when the answer scan finished.

import { inArray } from 'drizzle-orm';
import { learnerDayWindowUtc, learnerLocalDay } from '@/core/learner-day';
import type { Db } from '@/db/client';
import { knowledge } from '@/db/schema';
import { getEvents } from '@/kernel/events';
import {
  type SettledKnowledgeAnswerCounts,
  loadSettledKnowledgeAnswerCounts,
} from '@/kernel/read-models/learner-activity';
import type { YesterdayFocusSettlement, YesterdayPlanOutcome } from './yesterday-focus';

const YESTERDAY_SCAN_LIMIT = 50;

function previousLearnerDay(day: string): string {
  const { from } = learnerDayWindowUtc(day, day);
  return learnerLocalDay(new Date(from.getTime() - 1));
}

function readPlanFocus(payload: unknown): { planned: true; focus: string[] } | { planned: false } {
  if (!payload || typeof payload !== 'object') return { planned: false };
  const todayPlan = (payload as { today_plan?: unknown }).today_plan;
  if (!todayPlan || typeof todayPlan !== 'object') return { planned: false };
  const proposal = (todayPlan as { review_session_proposal?: unknown }).review_session_proposal;
  const raw =
    proposal && typeof proposal === 'object'
      ? (proposal as { knowledge_focus?: unknown }).knowledge_focus
      : undefined;
  if (!Array.isArray(raw)) return { planned: true, focus: [] };
  const focus: string[] = [];
  const seen = new Set<string>();
  for (const id of raw) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    focus.push(id);
  }
  return { planned: true, focus };
}

function settlementOf(
  counts: SettledKnowledgeAnswerCounts | undefined,
  complete: boolean,
): YesterdayFocusSettlement {
  const correct = counts?.correct ?? 0;
  const wrong = counts?.wrong ?? 0;
  const partial = counts?.partial ?? 0;
  if (correct + wrong + partial > 0) return { kind: 'practiced', correct, wrong, partial };
  if (!complete) return { kind: 'unknown' };
  return { kind: 'not_practiced' };
}

async function knowledgeNames(db: Db, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: knowledge.id, name: knowledge.name })
    .from(knowledge)
    .where(inArray(knowledge.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row.name]));
}

export async function loadYesterdayPlanOutcome(
  db: Db,
  now: Date,
): Promise<YesterdayPlanOutcome | null> {
  const planDay = previousLearnerDay(learnerLocalDay(now));
  const window = learnerDayWindowUtc(planDay, planDay);
  const scans = await getEvents(db, {
    action: 'experimental:coach_scan',
    since: window.from,
    limit: YESTERDAY_SCAN_LIMIT,
  });
  let plannedAt: Date | null = null;
  let focus: string[] = [];
  for (const scan of scans) {
    if (scan.created_at >= window.to) continue;
    const plan = readPlanFocus(scan.payload);
    if (!plan.planned) continue;
    plannedAt = scan.created_at;
    focus = plan.focus;
    break;
  }
  if (!plannedAt || focus.length === 0) return null;
  const [settled, names] = await Promise.all([
    loadSettledKnowledgeAnswerCounts(db, {
      knowledgeIds: focus,
      since: plannedAt,
      until: now,
    }),
    knowledgeNames(db, focus),
  ]);
  return {
    plan_day: planDay,
    planned_at: plannedAt.toISOString(),
    focuses: focus.map((knowledgeId) => ({
      knowledge_id: knowledgeId,
      knowledge_name: names.get(knowledgeId) ?? null,
      settlement: settlementOf(settled.counts.get(knowledgeId), settled.complete),
    })),
  };
}
