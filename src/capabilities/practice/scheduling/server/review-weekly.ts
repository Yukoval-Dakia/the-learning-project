// Weekly review report shared by HTTP and Start.
//
// Aggregates review event activity over a sliding window (default 7d, max 90d):
// count/correct rate per day, FSRS rating distribution, top knowledge_ids by
// failure count, top effective cause categories, and total AI cost.
//
// Single-shot per page load; computed at request time (no view). Acceptable at
// single-user scale where the window is bounded and the event table is small.

import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { loadNativeReviewOccurrences } from '@/kernel/read-models/assessment-review-occurrences';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import { getCurrentFailureAttempts } from '@/kernel/read-models/failure-attempts';
import { resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
import { ReviewWeeklyQuerySchema } from '../api/review-planning-contracts';
import {
  buildCalendarReportWindow,
  localDateKey,
  resolveReportTimeZone,
} from '../api/weekly-window';

export type WeeklyReportQuery = z.input<typeof ReviewWeeklyQuerySchema>;

const MAX_DAYS = 90;
const DEFAULT_DAYS = 7;

type WeeklyReview = {
  at: Date;
  rating: string | null;
  outcome: 'success' | 'failure' | 'partial' | null;
};

function storedOutcome(value: string | null): WeeklyReview['outcome'] {
  return value === 'success' || value === 'failure' || value === 'partial' ? value : null;
}

function stringField(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== 'object' || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Keys that mean this row is the same issuance or the same answer as another row.
 * A stream item is a practice slot, not an answer: one slot can hold several reviews
 * and nothing distinguishes them, so it never collapses two rows. Only rows naming the
 * same event, group or issuance (the stream answer's own issuance id) do.
 */
function reviewIdentityKeys(input: {
  eventId?: string;
  groupId?: string;
  issuanceId?: string;
}): string[] {
  const keys: string[] = [];
  if (input.eventId) keys.push(`event:${input.eventId}`);
  if (input.groupId) keys.push(`group:${input.groupId}`);
  if (input.issuanceId) keys.push(`issuance:${input.issuanceId}`);
  return keys;
}

/**
 * Stream answers are issued as `iss_stream_<slot>`, so a legacy review row that kept only
 * `stream_item_id` still names the issuance a settlement receipt claimed for that answer.
 */
function slotIssuanceKey(streamItemId: string): string {
  return `issuance:iss_stream_${streamItemId}`;
}

export async function loadWeeklyReview(db: Db, input: unknown) {
  const parsedQuery = ReviewWeeklyQuerySchema.safeParse(input);
  if (!parsedQuery.success) {
    throw new ApiError('validation_error', 'weekly report query fields must be strings');
  }
  const daysRaw = parsedQuery.data.days;
  const parsedDays = daysRaw ? Number.parseInt(daysRaw, 10) : DEFAULT_DAYS;
  const days = Math.min(
    Math.max(Number.isNaN(parsedDays) ? DEFAULT_DAYS : parsedDays, 1),
    MAX_DAYS,
  );
  let timeZone: string;
  try {
    timeZone = resolveReportTimeZone(parsedQuery.data.timezone);
  } catch {
    throw new ApiError('invalid_timezone', 'timezone must be a valid IANA time zone');
  }
  const now = new Date();
  const reportWindow = buildCalendarReportWindow(now, days, timeZone);
  const cutoff = reportWindow.from;
  const inWindow = and(gte(event.created_at, cutoff), lte(event.created_at, now));

  const nativeOccurrences = (await loadNativeReviewOccurrences(db)).filter(
    (occurrence) => occurrence.occurredAt >= cutoff && occurrence.occurredAt <= now,
  );
  const groupIds = [...new Set(nativeOccurrences.map((occurrence) => occurrence.groupId))];
  const nativeAnchors =
    groupIds.length === 0
      ? []
      : await db
          .select({ id: event.id, payload: event.payload })
          .from(event)
          .where(
            and(
              eq(event.action, 'experimental:assessment_attempt'),
              eq(event.subject_kind, 'question'),
              inArray(sql<string>`${event.payload}->>'evaluation_group_id'`, groupIds),
            ),
          );
  const claimed = new Set<string>();
  const reviews: WeeklyReview[] = [];
  for (const occurrence of nativeOccurrences) {
    const anchors = nativeAnchors.filter(
      (anchor) => stringField(anchor.payload, 'evaluation_group_id') === occurrence.groupId,
    );
    const keys = [
      ...reviewIdentityKeys({ groupId: occurrence.groupId }),
      ...anchors.flatMap((anchor) =>
        reviewIdentityKeys({
          eventId: anchor.id,
          issuanceId: stringField(anchor.payload, 'issuance_id') ?? undefined,
        }),
      ),
    ];
    for (const key of keys) claimed.add(key);
    reviews.push({
      at: occurrence.occurredAt,
      rating: occurrence.rating,
      outcome: storedOutcome(occurrence.outcome),
    });
  }
  const legacyReviews = await db
    .select({
      id: event.id,
      outcome: event.outcome,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(and(eq(event.action, 'review'), eq(event.subject_kind, 'question'), inWindow))
    // Stable pre-dedupe order: rows sharing an issuance must always keep the same winner,
    // and the newest review is the one that decided the answer's rating.
    .orderBy(desc(event.created_at), desc(event.id));
  for (const row of legacyReviews) {
    const keys = reviewIdentityKeys({
      eventId: row.id,
      issuanceId: stringField(row.payload, 'issuance_id') ?? undefined,
    });
    // A legacy row names only the slot it answered, so it repeats a receipt's answer when
    // that receipt already claimed the slot's issuance. Match only: claiming would swallow
    // the slot's later reviews.
    const slotItemId = stringField(row.payload, 'stream_item_id');
    if (keys.some((key) => claimed.has(key))) continue;
    if (slotItemId && claimed.has(slotIssuanceKey(slotItemId))) continue;
    for (const key of keys) claimed.add(key);
    reviews.push({
      at: row.created_at,
      rating: stringField(row.payload, 'fsrs_rating'),
      outcome: storedOutcome(row.outcome),
    });
  }

  // 2) Failure attempts in window — for top struggling knowledge_ids + cause.
  const failures = (await getCurrentFailureAttempts(db, { since: cutoff })).filter(
    (row) => row.created_at <= now,
  );

  // 3) Cost — sum cost_micro_usd over any event in window.
  const costRows = await db
    .select({ sum: sql<number>`COALESCE(SUM(${event.cost_micro_usd}), 0)::bigint` })
    .from(event)
    .where(inWindow);
  const totalCostMicroUsd = Number(costRows[0]?.sum ?? 0);

  // 4) Effective causes from in-window failure attempts.
  const causeCounts = new Map<string, number>();
  for (const failure of failures) {
    const cat = effectiveCauseForFailureAttempt(failure)?.primary_category;
    if (cat) causeCounts.set(cat, (causeCounts.get(cat) ?? 0) + 1);
  }
  // misc_ category id 的显示回填（active misconception title）。
  const topCauseLabels = await resolveMiscCauseLabels(db, [...causeCounts.keys()]);
  const topCauses = [...causeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([category, count]) => ({
      category,
      category_label: topCauseLabels.get(category) ?? null,
      count,
    }));

  // 5) Rating distribution from review event payloads.
  const ratingCounts: Record<string, number> = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const r of reviews) {
    if (r.rating && r.rating in ratingCounts) ratingCounts[r.rating] += 1;
  }

  // 6) Daily trend buckets use the learner's calendar days. A seven-day report
  //    includes today plus the six preceding local dates, including across DST.
  const dailyMap = new Map<
    string,
    {
      date: string;
      count: number;
      correct: number;
      incorrect: number;
      partial: number;
      ungraded: number;
    }
  >();
  for (const key of reportWindow.dateKeys) {
    dailyMap.set(key, { date: key, count: 0, correct: 0, incorrect: 0, partial: 0, ungraded: 0 });
  }
  for (const r of reviews) {
    const key = localDateKey(r.at, timeZone);
    const bucket = dailyMap.get(key);
    if (bucket) {
      bucket.count += 1;
      if (r.outcome === 'success') bucket.correct += 1;
      else if (r.outcome === 'failure') bucket.incorrect += 1;
      else if (r.outcome === 'partial') bucket.partial += 1;
      else bucket.ungraded += 1;
    }
  }
  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  // 7) Top struggling knowledge_ids — referenced_knowledge_ids on failure
  //    attempts; resolve names via knowledge table.
  const knowledgeCounts = new Map<string, number>();
  for (const f of failures) {
    const ids = f.referenced_knowledge_ids;
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

  return {
    window: {
      days,
      from: Math.floor(cutoff.getTime() / 1000),
      to: Math.floor(now.getTime() / 1000),
      time_zone: timeZone,
    },
    totals: {
      reviews: reviews.length,
      // failures 计【当前仍 effective 判错】的 attempt；已翻转的
      // 原始执行收据不计入（双轨：原始 raw attempts 仍在流里，不改写历史）。
      failures: failures.length,
      cost_usd: totalCostMicroUsd / 1e6,
    },
    ratings: ratingCounts,
    daily,
    top_causes: topCauses,
    top_knowledge: topKnowledge,
  };
}
