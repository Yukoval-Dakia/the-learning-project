// Read-only longitudinal trend read model. Calibration maturity answers how precise
// the data is now; this answers whether a KC or subject moved relative to its own past.
//
// Source is the per-attempt mastery_progress event (delta, p(L), theta and timestamp).
// This is its first longitudinal consumer.
//
// Pure read and aggregation: never writes back to mastery, calibration or FSRS. It is
// an observation surface, not a feedback loop.
//
// A trend is never a raw delta: output is a qualitative direction and confidence plus
// evidence count. A trend is a delta of deltas, so insufficient/low are first-class
// states. Degraded KCs set has_mastery_signal=false, and the UI shows an activity
// proxy instead of pretending mastery moved.

import { and, asc, desc, eq, gte, lt } from 'drizzle-orm';
import { MASTERY_PROGRESS_ACTION } from '@/core/schema/event';
import type { Db, Tx } from '@/db/client';
import { event, knowledge } from '@/db/schema';
import {
  type EffectivenessTrendPoint,
  type EffectivenessTrendSummary,
  type TrendConfidence,
  type TrendDirection,
  numOrNull,
  rollupSubjectDirection,
  summarizeTrend,
} from './effectiveness-trend-summary';

// Pure trend math lives in effectiveness-trend-summary.ts so it can run without a DB.
// This file keeps the schema-dependent assembly and derived axes, and re-exports the
// public types for existing importers.
export type {
  EffectivenessTrendPoint,
  EffectivenessTrendSummary,
  TrendConfidence,
  TrendDirection,
} from './effectiveness-trend-summary';
export {
  EFFECT_RATIO_HIGH,
  EFFECT_RATIO_MEDIUM,
  FIRM_TREND_EVIDENCE,
  HOLDING_BAND_THETA,
  MIN_EVENTS_FOR_TREND,
  summarizeTrend,
} from './effectiveness-trend-summary';

type DbLike = Db | Tx;

export interface EffectivenessTrendSeries {
  knowledge_id: string;
  /** Null when the KC row is gone. */
  name: string | null;
  /** Domain inherited along the parent chain; null when unknown. */
  effective_domain: string | null;
  /** Ascending by created_at. */
  points: EffectivenessTrendPoint[];
  trend: EffectivenessTrendSummary;
  /** Total events, used as the activity proxy in degraded states. */
  activity_count: number;
}

export interface SubjectTrendRollup {
  effective_domain: string | null;
  /** Dominant direction; insufficient when no KC has a credible signal. */
  direction: TrendDirection;
  confidence: TrendConfidence;
  kc_count: number;
  /** KCs with a credible mastery trend; zero means show the activity proxy. */
  kc_with_mastery_signal: number;
  activity_count: number;
}

export interface EffectivenessTrendAggregate {
  total_kcs_with_activity: number;
  total_events: number;
  by_subject: SubjectTrendRollup[];
}

export interface EffectivenessTrendResponse {
  /** Globally bounded notable non-root KCs only. */
  series: EffectivenessTrendSeries[];
  /** Active subject-root trajectories are kept separate from notable KCs. */
  subject_roots: EffectivenessTrendSeries[];
  aggregate: EffectivenessTrendAggregate;
  metadata: {
    as_of: string;
    window_start: string;
    window_end: string;
    timezone: 'Asia/Shanghai';
    granularity: 'calendar_day';
    notable_limit: 6;
    eligible: number;
    returned: number;
    truncated: boolean;
  };
}

interface MasteryProgressEventRow {
  id: string;
  subject_id: string;
  created_at: Date;
  payload: Record<string, unknown>;
}

/**
 * Walk parent ids to the first non-null domain. All knowledge rows resolve ancestors,
 * including archived intermediates; eligible events still only cover active KCs. The
 * seen set guards cycles.
 */
function buildEffectiveDomainResolver(
  rows: Array<{ id: string; domain: string | null; parent_id: string | null }>,
): (id: string) => string | null {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return (id: string): string | null => {
    let cur = byId.get(id);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.domain) return cur.domain;
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined;
    }
    return null;
  };
}

const NOTABLE_LIMIT = 6;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const isSubjectRoot = (id: string): boolean => /^seed:[^:]+:root$/.test(id);

function compareBinary(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function responseWindow(asOf: Date): { windowStart: Date; windowEnd: Date } {
  const shifted = new Date(asOf.getTime() + SHANGHAI_OFFSET_MS);
  const localMidnightUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  return {
    windowStart: new Date(localMidnightUtc - SHANGHAI_OFFSET_MS - 29 * DAY_MS),
    windowEnd: asOf,
  };
}

function calendarDay(at: Date): string {
  return new Date(at.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Per-KC trend series plus subject rollups. Progress events are grouped by KC and
 * time, summarized, then rolled up along effective domain. Read-only.
 */
export async function loadEffectivenessTrend(
  db: DbLike,
  asOf = new Date(),
): Promise<EffectivenessTrendResponse> {
  const { windowStart, windowEnd } = responseWindow(asOf);
  const events = (await db
    .select({
      id: event.id,
      subject_id: event.subject_id,
      created_at: event.created_at,
      payload: event.payload,
    })
    .from(event)
    .where(
      and(
        eq(event.action, MASTERY_PROGRESS_ACTION),
        eq(event.subject_kind, 'knowledge'),
        gte(event.created_at, windowStart),
        lt(event.created_at, windowEnd),
        lt(event.created_at, asOf),
      ),
    )
    .orderBy(
      asc(event.subject_id),
      desc(event.created_at),
      desc(event.id),
    )) as MasteryProgressEventRow[];

  // One full knowledge scan supplies names and domain ancestry; the graph is small.
  const knowledgeRows = await db
    .select({
      id: knowledge.id,
      name: knowledge.name,
      domain: knowledge.domain,
      parent_id: knowledge.parent_id,
      archived_at: knowledge.archived_at,
    })
    .from(knowledge);
  const activeRows = knowledgeRows.filter((row) => row.archived_at === null);
  const nameById = new Map(activeRows.map((r) => [r.id, r.name]));
  const resolveEffectiveDomain = buildEffectiveDomainResolver(knowledgeRows);

  const activeIds = new Set(activeRows.map((row) => row.id));
  const latestByKcDay = new Map<string, MasteryProgressEventRow>();
  const activityByKc = new Map<string, number>();
  for (const ev of events) {
    if (!activeIds.has(ev.subject_id)) continue;
    activityByKc.set(ev.subject_id, (activityByKc.get(ev.subject_id) ?? 0) + 1);
    const key = `${ev.subject_id}\0${calendarDay(ev.created_at)}`;
    if (!latestByKcDay.has(key)) latestByKcDay.set(key, ev);
  }

  const pointsByKc = new Map<string, EffectivenessTrendPoint[]>();
  const latestAtByKc = new Map<string, string>();
  for (const ev of latestByKcDay.values()) {
    const points = pointsByKc.get(ev.subject_id) ?? [];
    const at = ev.created_at.toISOString();
    points.push({
      at,
      p_learned: numOrNull(ev.payload.p_learned),
      theta_hat: numOrNull(ev.payload.theta_hat),
      theta_delta: numOrNull(ev.payload.theta_delta),
    });
    pointsByKc.set(ev.subject_id, points);
    if (at > (latestAtByKc.get(ev.subject_id) ?? '')) latestAtByKc.set(ev.subject_id, at);
  }

  const allSeries: EffectivenessTrendSeries[] = [];
  for (const [knowledgeId, points] of pointsByKc) {
    // Re-sort explicitly in case map iteration or equal timestamps reorder points.
    points.sort((a, b) => compareBinary(a.at, b.at));
    allSeries.push({
      knowledge_id: knowledgeId,
      name: nameById.get(knowledgeId) ?? null,
      effective_domain: resolveEffectiveDomain(knowledgeId),
      points,
      trend: summarizeTrend(points),
      activity_count: activityByKc.get(knowledgeId) ?? 0,
    });
  }
  allSeries.sort((a, b) => compareBinary(a.knowledge_id, b.knowledge_id));

  // Group by effective domain; a NUL key stands in for null and cannot collide.
  const NULL_DOMAIN = ' ';
  const bySubject = new Map<
    string,
    {
      effective_domain: string | null;
      trends: EffectivenessTrendSummary[];
      activity: number;
      kc: number;
    }
  >();
  for (const s of allSeries) {
    const key = s.effective_domain ?? NULL_DOMAIN;
    const bucket = bySubject.get(key) ?? {
      effective_domain: s.effective_domain,
      trends: [],
      activity: 0,
      kc: 0,
    };
    bucket.trends.push(s.trend);
    bucket.activity += s.activity_count;
    bucket.kc += 1;
    bySubject.set(key, bucket);
  }

  const subjectRollups: SubjectTrendRollup[] = Array.from(bySubject.values()).map((bucket) => {
    const { direction, confidence } = rollupSubjectDirection(bucket.trends);
    return {
      effective_domain: bucket.effective_domain,
      direction,
      confidence,
      kc_count: bucket.kc,
      kc_with_mastery_signal: bucket.trends.filter((t) => t.has_mastery_signal).length,
      activity_count: bucket.activity,
    };
  });
  // Domain ascending, null last.
  subjectRollups.sort((a, b) => {
    if (a.effective_domain === b.effective_domain) return 0;
    if (a.effective_domain === null) return 1;
    if (b.effective_domain === null) return -1;
    return compareBinary(a.effective_domain, b.effective_domain);
  });

  const subjectRoots = allSeries.filter((row) => isSubjectRoot(row.knowledge_id));
  const eligibleSeries = allSeries.filter(
    (row) =>
      !isSubjectRoot(row.knowledge_id) &&
      (row.trend.direction === 'rising' || row.trend.direction === 'falling'),
  );
  const trendMagnitude = (row: EffectivenessTrendSeries): number => {
    const values = row.points
      .map((point) => point.theta_hat)
      .filter((value): value is number => value !== null);
    const half = Math.floor(values.length / 2);
    if (half === 0) return 0;
    const mean = (xs: number[]) => xs.reduce((sum, value) => sum + value, 0) / xs.length;
    return Math.abs(mean(values.slice(values.length - half)) - mean(values.slice(0, half)));
  };
  eligibleSeries.sort((a, b) => {
    const magnitudeOrder = trendMagnitude(b) - trendMagnitude(a);
    if (magnitudeOrder !== 0) return magnitudeOrder;
    const aLatest = latestAtByKc.get(a.knowledge_id) ?? '';
    const bLatest = latestAtByKc.get(b.knowledge_id) ?? '';
    const recencyOrder = compareBinary(bLatest, aLatest);
    if (recencyOrder !== 0) return recencyOrder;
    return compareBinary(a.knowledge_id, b.knowledge_id);
  });
  const series = eligibleSeries.slice(0, NOTABLE_LIMIT);

  return {
    series,
    subject_roots: subjectRoots,
    aggregate: {
      total_kcs_with_activity: allSeries.length,
      total_events: Array.from(activityByKc.values()).reduce((sum, count) => sum + count, 0),
      by_subject: subjectRollups,
    },
    metadata: {
      as_of: asOf.toISOString(),
      window_start: windowStart.toISOString(),
      window_end: windowEnd.toISOString(),
      timezone: 'Asia/Shanghai',
      granularity: 'calendar_day',
      notable_limit: NOTABLE_LIMIT,
      eligible: eligibleSeries.length,
      returned: series.length,
      truncated: eligibleSeries.length > series.length,
    },
  };
}
