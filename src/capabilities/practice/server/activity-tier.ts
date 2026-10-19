import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import {
  type ActivityTier,
  LEARNING_EVENT_ACTIONS,
  classifyActivityTier,
} from '@/kernel/nightly-eligibility';

export async function loadActivityTier(db: Db, now: Date, before?: Date): Promise<ActivityTier> {
  const [row] = await db
    .select({ at: sql<string | null>`max(${event.created_at})` })
    .from(event)
    .where(
      and(
        eq(event.actor_kind, 'user'),
        inArray(event.action, [...LEARNING_EVENT_ACTIONS]),
        eventAllowsDerivationSql(),
        before ? lt(event.created_at, before) : undefined,
      ),
    );
  return classifyActivityTier({
    now,
    lastLearnerEventAt: asDate(row?.at),
    examWindow: false,
  });
}

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
