// Phase 1d — weekly review report endpoint.
//
// Aggregates review event activity over a sliding window (default 7d, max 90d):
//   - Per-day count + correct rate
//   - Overall FSRS rating distribution
//   - Top knowledge_ids by attempt:failure count in window
//   - Top cause categories from effective failure causes
//   - Total AI cost (cost_micro_usd sum across events in window)
//
// Single-shot per page load; computed at request time (no view). Acceptable for
// single-user scale where the window is bounded and the event table is small.

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import { db } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { effectiveCauseForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttempts } from '@/server/events/queries';
import { ApiError, errorResponse } from '@/server/http/errors';
import { buildCalendarReportWindow, localDateKey, resolveReportTimeZone } from './weekly-window';

const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const daysRaw = url.searchParams.get('days');
    const parsedDays = daysRaw ? Number.parseInt(daysRaw, 10) : DEFAULT_DAYS;
    const days = Math.min(
      Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
      MAX_DAYS,
    );
    let timeZone: string;
    try {
      timeZone = resolveReportTimeZone(url.searchParams.get('timezone'));
    } catch {
      throw new ApiError('invalid_timezone', 'timezone must be a valid IANA time zone');
    }
    const now = new Date();
    const reportWindow = buildCalendarReportWindow(now, days, timeZone);
    const cutoff = reportWindow.from;
    const inWindow = and(gte(event.created_at, cutoff), lte(event.created_at, now));

    // 1) Review events in window — for rating distribution + daily trend.
    const reviews = await db
      .select({
        id: event.id,
        outcome: event.outcome,
        payload: event.payload,
        created_at: event.created_at,
      })
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_kind, 'question'), inWindow));

    // 2) Failure attempts in window — for top struggling knowledge_ids + cause.
    const failures = await db
      .select({
        id: event.id,
        payload: event.payload,
      })
      .from(event)
      .where(
        and(
          eq(event.action, 'attempt'),
          eq(event.subject_kind, 'question'),
          eq(event.outcome, 'failure'),
          inWindow,
        ),
      );

    // 3) Cost — sum cost_micro_usd over any event in window.
    const costRows = await db
      .select({ sum: sql<number>`COALESCE(SUM(${event.cost_micro_usd}), 0)::bigint` })
      .from(event)
      .where(inWindow);
    const totalCostMicroUsd = Number(costRows[0]?.sum ?? 0);

    // 4) Effective causes from in-window failure attempts.
    const failureIds = failures.map((f) => f.id);
    const failureIdSet = new Set(failureIds);
    const causeCounts = new Map<string, number>();
    if (failureIds.length > 0) {
      const activeFailures = await getFailureAttempts(db, {
        since: cutoff,
        limit: Math.max(failureIds.length * 2, 100),
      });
      for (const failure of activeFailures) {
        if (!failureIdSet.has(failure.attempt_event_id)) continue;
        const cat = effectiveCauseForFailureAttempt(failure)?.primary_category;
        if (cat) causeCounts.set(cat, (causeCounts.get(cat) ?? 0) + 1);
      }
    }
    const topCauses = [...causeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([category, count]) => ({ category, count }));

    // 5) Rating distribution from review event payloads.
    const ratingCounts: Record<string, number> = { again: 0, hard: 0, good: 0, easy: 0 };
    for (const r of reviews) {
      const rating = (r.payload as { fsrs_rating?: string }).fsrs_rating;
      if (rating && rating in ratingCounts) ratingCounts[rating] += 1;
    }

    // 6) Daily trend buckets use the learner's calendar days. A seven-day report
    //    includes today plus the six preceding local dates, including across DST.
    const dailyMap = new Map<string, { date: string; count: number; correct: number }>();
    for (const key of reportWindow.dateKeys) {
      dailyMap.set(key, { date: key, count: 0, correct: 0 });
    }
    for (const r of reviews) {
      const key = localDateKey(r.created_at, timeZone);
      const bucket = dailyMap.get(key);
      if (bucket) {
        bucket.count += 1;
        if (r.outcome === 'success') bucket.correct += 1;
      }
    }
    const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

    // 7) Top struggling knowledge_ids — referenced_knowledge_ids on failure
    //    attempts; resolve names via knowledge table.
    const knowledgeCounts = new Map<string, number>();
    for (const f of failures) {
      const ids = (f.payload as { referenced_knowledge_ids?: string[] }).referenced_knowledge_ids;
      if (!Array.isArray(ids)) continue;
      for (const kid of ids) {
        knowledgeCounts.set(kid, (knowledgeCounts.get(kid) ?? 0) + 1);
      }
    }
    const topKnowledgeEntries = [...knowledgeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const topKnowledgeIds = topKnowledgeEntries.map(([id]) => id);
    const nameById = new Map<string, string>();
    if (topKnowledgeIds.length > 0) {
      const rows = await db
        .select({ id: knowledge.id, name: knowledge.name })
        .from(knowledge)
        .where(inArray(knowledge.id, topKnowledgeIds));
      for (const k of rows) nameById.set(k.id, k.name);
    }
    const topKnowledge = topKnowledgeEntries.map(([id, count]) => ({
      id,
      name: nameById.get(id) ?? id,
      failure_count: count,
    }));

    return Response.json({
      window: {
        days,
        from: Math.floor(cutoff.getTime() / 1000),
        to: Math.floor(now.getTime() / 1000),
        time_zone: timeZone,
      },
      totals: {
        reviews: reviews.length,
        failures: failures.length,
        cost_usd: totalCostMicroUsd / 1e6,
      },
      ratings: ratingCounts,
      daily,
      top_causes: topCauses,
      top_knowledge: topKnowledge,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
