// Weekly review report shared by HTTP and Start.
//
// Aggregates review event activity over a sliding window (default 7d, max 90d):
// count/correct rate per day, FSRS rating distribution, knowledge points whose
// in-window failures still have no later independent correct answer, top effective
// cause categories, and total AI cost. That ranking is weighted by the weaker of
// mastery and retention, and compared with the previous window of the same length.
//
// Single-shot per page load; computed at request time (no view). Acceptable at
// single-user scale where the window is bounded and the event table is small.

import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { RetentionReading } from '@/core/schema/scheduling-state';
import type { Db } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { loadNativeReviewOccurrences } from '@/kernel/read-models/assessment-review-occurrences';
import { effectiveCauseForFailureAttempt } from '@/kernel/read-models/cause-policy';
import {
  type FailureAttempt,
  getCurrentFailureAttempts,
} from '@/kernel/read-models/failure-attempts';
import { loadRecentCorrectAttemptsForKnowledge } from '@/kernel/read-models/learner-activity';
import { getMasteryProjection } from '@/kernel/read-models/mastery-projection';
import { resolveMiscCauseLabels } from '@/kernel/read-models/misc-cause-labels';
import { getFsrsRetrievabilityByIds } from '@/kernel/records/scheduling-state';
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

const TOP_KNOWLEDGE = 8;
// A fully held point still counts, at a quarter of an unheld one with the same open failures.
const HOLD_FLOOR = 0.25;

/** Where an open failure stands against the previous window of the same length. */
type KnowledgeStanding = 'fixed' | 'still_unresolved' | 'added';

interface KnowledgeFailureTally {
  /** Failures in the current window with no later independent correct answer. */
  currentOpen: number;
  /** Failures in the previous window that were still open when this window began. */
  priorOpen: number;
  /** Previous-window failures that are still open now. */
  priorStillOpen: number;
}

interface RankedKnowledgeFailure {
  id: string;
  name: string;
  unresolved_count: number;
  prior_unresolved_count: number;
  weight: number;
  mastery: number | null;
  retention: number | null;
  standing: KnowledgeStanding;
}

function standingOf(tally: KnowledgeFailureTally): KnowledgeStanding | null {
  if (tally.priorOpen > 0 && tally.currentOpen === 0 && tally.priorStillOpen === 0) return 'fixed';
  if (tally.priorOpen > 0) return 'still_unresolved';
  if (tally.currentOpen > 0) return 'added';
  return null;
}

function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function retentionScore(reading: RetentionReading | undefined): number | null {
  if (typeof reading === 'number') return clamp01(reading);
  if (reading?.kind === 'score') return clamp01(reading.value);
  return null;
}

/** Weaker known hold. Missing mastery and retention leave the count unscaled. */
function holdOf(mastery: number | null, retention: number | null): number | null {
  if (mastery != null && retention != null) return Math.min(mastery, retention);
  return mastery ?? retention;
}

function unresolvedWeight(count: number, hold: number | null): number {
  if (count <= 0) return 0;
  const multiplier = hold == null ? 1 : HOLD_FLOOR + (1 - HOLD_FLOOR) * (1 - clamp01(hold));
  return count * multiplier;
}

function knowledgeIdsOf(row: FailureAttempt): string[] {
  const ids = row.referenced_knowledge_ids;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))];
}

function clearedBy(
  times: readonly Date[] | undefined,
  failureAt: Date,
  until: Date,
  untilInclusive: boolean,
): boolean {
  if (!times || times.length === 0) return false;
  const after = failureAt.getTime();
  const end = until.getTime();
  return times.some((at) => {
    const ms = at.getTime();
    return ms > after && (untilInclusive ? ms <= end : ms < end);
  });
}

function emptyKnowledgeRanking(): {
  top: RankedKnowledgeFailure[];
  fixed: RankedKnowledgeFailure[];
  still_unresolved: RankedKnowledgeFailure[];
  added: RankedKnowledgeFailure[];
} {
  return { top: [], fixed: [], still_unresolved: [], added: [] };
}

/**
 * Failures that a later, separate correct answer has not cleared. A rejudge of the
 * same attempt never reaches this list. Weight uses the weaker of mastery and
 * retention so a slipping point outranks an equally failed point that is still held.
 */
async function rankOpenKnowledgeFailures(
  db: Db,
  input: { priorFrom: Date; currentFrom: Date; now: Date; rows: FailureAttempt[] },
): Promise<ReturnType<typeof emptyKnowledgeRanking>> {
  const knowledgeIds = [...new Set(input.rows.flatMap((row) => knowledgeIdsOf(row)))];
  if (knowledgeIds.length === 0) return emptyKnowledgeRanking();

  // Absence means no later independent success. The sample cap on this reader
  // can be filled by other knowledge points, so the ranking reads the whole window.
  const corrects = await loadRecentCorrectAttemptsForKnowledge(db, {
    knowledgeIds,
    since: input.priorFrom,
    exhaustive: true,
  });
  const successAt = new Map<string, Date[]>();
  for (const [id, attempts] of corrects) {
    successAt.set(
      id,
      attempts.map((attempt) => attempt.created_at).sort((a, b) => a.getTime() - b.getTime()),
    );
  }
  const tallies = new Map<string, KnowledgeFailureTally>();
  const bump = (id: string): KnowledgeFailureTally => {
    const tally = tallies.get(id) ?? { currentOpen: 0, priorOpen: 0, priorStillOpen: 0 };
    tallies.set(id, tally);
    return tally;
  };
  for (const row of input.rows) {
    const inCurrent = row.created_at >= input.currentFrom;
    for (const id of knowledgeIdsOf(row)) {
      const times = successAt.get(id);
      const openNow = !clearedBy(times, row.created_at, input.now, true);
      const openAtPriorEnd = !clearedBy(times, row.created_at, input.currentFrom, false);
      const tally = bump(id);
      if (inCurrent) {
        if (openNow) tally.currentOpen += 1;
      } else if (openAtPriorEnd) {
        tally.priorOpen += 1;
        if (openNow) tally.priorStillOpen += 1;
      }
    }
  }

  const emitted = [...tallies.entries()].filter(([, tally]) => standingOf(tally) !== null);
  if (emitted.length === 0) return emptyKnowledgeRanking();
  const ids = emitted.map(([id]) => id);
  const [projection, retentionById, nameRows] = await Promise.all([
    getMasteryProjection(db, ids),
    getFsrsRetrievabilityByIds(db, 'knowledge', ids, input.now),
    db
      .select({ id: knowledge.id, name: knowledge.name })
      .from(knowledge)
      .where(inArray(knowledge.id, ids)),
  ]);
  const nameById = new Map(nameRows.map((row) => [row.id, row.name]));
  const ranked = emitted.map(([id, tally]) => {
    const masteryRow = projection.get(id);
    const mastery =
      masteryRow && masteryRow.evidence_count > 0 ? clamp01(masteryRow.mastery) : null;
    const retention = retentionScore(retentionById.get(id));
    const standing = standingOf(tally);
    if (!standing) throw new Error('knowledge failure standing missing');
    return {
      id,
      name: nameById.get(id) ?? id,
      unresolved_count: tally.currentOpen,
      prior_unresolved_count: tally.priorOpen,
      weight: unresolvedWeight(tally.currentOpen, holdOf(mastery, retention)),
      mastery,
      retention,
      standing,
    };
  });
  const byWeight = (a: RankedKnowledgeFailure, b: RankedKnowledgeFailure) =>
    b.weight - a.weight || b.unresolved_count - a.unresolved_count || a.id.localeCompare(b.id);
  const byPrior = (a: RankedKnowledgeFailure, b: RankedKnowledgeFailure) =>
    b.prior_unresolved_count - a.prior_unresolved_count || a.id.localeCompare(b.id);
  const open = ranked
    .filter((row) => row.unresolved_count > 0)
    .sort(byWeight)
    .slice(0, TOP_KNOWLEDGE);
  return {
    top: open,
    fixed: ranked.filter((row) => row.standing === 'fixed').sort(byPrior),
    still_unresolved: ranked.filter((row) => row.standing === 'still_unresolved').sort(byWeight),
    added: ranked.filter((row) => row.standing === 'added').sort(byWeight),
  };
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

  // 2) Effective failures from the previous window through now. Totals and causes
  // stay on the current window; the knowledge ranking also needs the previous one.
  const priorWindow = buildCalendarReportWindow(
    new Date(reportWindow.from.getTime() - 1),
    days,
    timeZone,
  );
  const failureRows = (await getCurrentFailureAttempts(db, { since: priorWindow.from })).filter(
    (row) => row.created_at <= now,
  );
  const failures = failureRows.filter((row) => row.created_at >= cutoff);

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

  // 7) Knowledge points whose current-window failures have no later independent
  //    correct answer, weighted, plus the previous window's fixed / still open / new.
  const knowledgeRanking = await rankOpenKnowledgeFailures(db, {
    priorFrom: priorWindow.from,
    currentFrom: cutoff,
    now,
    rows: failureRows,
  });
  const topKnowledge = knowledgeRanking.top.map((row) => ({
    id: row.id,
    name: row.name,
    failure_count: row.unresolved_count,
    weight: row.weight,
    mastery: row.mastery,
    retention: row.retention,
    versus_prior: row.standing === 'still_unresolved' ? 'still_unresolved' : 'added',
  }));
  const compareRow = (row: RankedKnowledgeFailure) => ({
    id: row.id,
    name: row.name,
    unresolved_count: row.unresolved_count,
    prior_unresolved_count: row.prior_unresolved_count,
    weight: row.weight,
    mastery: row.mastery,
    retention: row.retention,
  });

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
    knowledge_week_compare: {
      fixed: knowledgeRanking.fixed.map(compareRow),
      still_unresolved: knowledgeRanking.still_unresolved.map(compareRow),
      added: knowledgeRanking.added.map(compareRow),
    },
  };
}
