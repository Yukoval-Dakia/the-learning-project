// Answers on the whole-profile daily stream. Those slots keep session_id null —
// that null is the partition — so the answers are recorded with a null session
// too. The day's review session finds them by stream slot, not by session_id.

import { and, asc, eq, inArray, isNull, min, sql } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event, practice_stream_item } from '@/db/schema';
import { LEARNER_ANSWER_ACTIONS } from '@/kernel/read-models/learner-activity';

const DAILY_STREAM_ENTRYPOINT_PREFIX = 'daily-stream:';
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

type DbLike = Db | Tx;

/** Identity of the review session that summarizes one whole-profile daily stream. */
export function dailyStreamEntrypoint(date: string): string {
  if (!CALENDAR_DATE.test(date)) {
    throw new Error(`daily stream date must be YYYY-MM-DD (got ${date})`);
  }
  return `${DAILY_STREAM_ENTRYPOINT_PREFIX}${date}`;
}

/** Calendar date carried by a daily-stream session, or null for every other session. */
export function dailyStreamDateOf(entrypoint: string | null): string | null {
  if (!entrypoint?.startsWith(DAILY_STREAM_ENTRYPOINT_PREFIX)) return null;
  const date = entrypoint.slice(DAILY_STREAM_ENTRYPOINT_PREFIX.length);
  return CALENDAR_DATE.test(date) ? date : null;
}

async function dailySlotIds(db: DbLike, date: string): Promise<string[]> {
  const rows = await db
    .select({ id: practice_stream_item.id })
    .from(practice_stream_item)
    .where(and(eq(practice_stream_item.date, date), isNull(practice_stream_item.session_id)));
  return rows.map((row) => row.id);
}

function answersOnDailySlots(slotIds: string[]) {
  return and(
    isNull(event.session_id),
    eq(event.subject_kind, 'question'),
    inArray(event.action, [...LEARNER_ANSWER_ACTIONS]),
    inArray(sql`${event.payload}->>'stream_item_id'`, slotIds),
  );
}

/** Learner answers recorded on that day's whole-profile slots. */
export async function loadDailyStreamAnswers(db: DbLike, date: string) {
  const slotIds = await dailySlotIds(db, date);
  if (slotIds.length === 0) return [];
  return db
    .select()
    .from(event)
    .where(answersOnDailySlots(slotIds))
    .orderBy(asc(event.created_at), asc(event.dispatch_seq));
}

/** Earliest of those answers, so the session's start is the practice, not the close. */
export async function earliestDailyStreamAnswerAt(
  db: DbLike,
  date: string,
): Promise<Date | undefined> {
  const slotIds = await dailySlotIds(db, date);
  if (slotIds.length === 0) return undefined;
  const [row] = await db
    .select({ at: min(event.created_at) })
    .from(event)
    .where(answersOnDailySlots(slotIds));
  return calendarInstant(row?.at);
}

function calendarInstant(value: unknown): Date | undefined {
  if (value == null) return undefined;
  const at = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now()) return undefined;
  return at;
}
