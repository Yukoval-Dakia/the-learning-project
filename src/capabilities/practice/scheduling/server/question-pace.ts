// observed question pace for the daily review plan.
// The plan and the practice stream must not disagree about how long a question
// takes. This reader is the only place that derives the measured value; both
// surfaces pass it into `@/core/daily-review-plan`.
// Samples are the learner's own `duration_ms` on the last 200 question
// attempts/reviews within 14 days. Wall-clock timing includes idle time, so
// samples above 10 minutes are dropped (a backgrounded tab is not a slower
// question), sub-second samples are ignored, the remaining samples are
// summarized by their median, and fewer than 5 usable samples falls back to
// the default (2 minutes).

import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import {
  DEFAULT_QUESTION_MINUTES,
  MAX_QUESTION_MINUTES,
  normalizeQuestionMinutes,
} from '@/core/daily-review-plan';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { LEARNER_ANSWER_ACTIONS } from '@/kernel/read-models/learner-activity';
import { medianOf } from '@/kernel/read-models/question-activity';

type DbLike = Db | Tx;

export const QUESTION_PACE_WINDOW_DAYS = 14;
export const QUESTION_PACE_SAMPLE_LIMIT = 200;
export const QUESTION_PACE_MIN_SAMPLES = 5;
const MIN_SAMPLE_MS = 1_000;
const MAX_SAMPLE_MS = MAX_QUESTION_MINUTES * 60_000;

export interface QuestionPace {
  minutes: number;
  source: 'observed' | 'default';
  sample_count: number;
}

export async function readQuestionPace(db: DbLike, now: Date = new Date()): Promise<QuestionPace> {
  const since = new Date(now.getTime() - QUESTION_PACE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
        eq(event.subject_kind, 'question'),
        gte(event.created_at, since),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(QUESTION_PACE_SAMPLE_LIMIT);

  const samples = rows
    .map((row) => (row.payload as { duration_ms?: unknown }).duration_ms)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    .filter((value) => value >= MIN_SAMPLE_MS && value <= MAX_SAMPLE_MS);

  if (samples.length < QUESTION_PACE_MIN_SAMPLES) {
    return { minutes: DEFAULT_QUESTION_MINUTES, source: 'default', sample_count: samples.length };
  }
  // Median, not mean: one backgrounded tab must not move the whole day's count.
  const medianMs = medianOf(samples) ?? DEFAULT_QUESTION_MINUTES * 60_000;
  return {
    minutes: normalizeQuestionMinutes(medianMs / 60_000),
    source: 'observed',
    sample_count: samples.length,
  };
}
