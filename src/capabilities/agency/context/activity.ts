import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import type { EventSubscriptionHandlerFactory } from '@/kernel/manifest';
import { getStartedBoss } from '@/server/boss/client';
import { CURATOR_ACTIVITY_ACTIONS } from './activity-contract';
import { runCurator } from './curator';
export const buildCuratorActivitySubscriber: EventSubscriptionHandlerFactory =
  (db) => async (delivery) => {
    const [source] = await db
      .select()
      .from(event)
      .where(and(eq(event.id, delivery.sourceEventId), eventAllowsDerivationSql()));
    if (!source) return { status: 'skipped', reason: 'restricted or missing activity' };
    const hex = createHash('sha256').update(`curator:${source.id}`).digest('hex');
    const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    await (await getStartedBoss()).send(
      'curator_activity',
      { source_id: source.id },
      {
        id,
        startAfter: new Date(source.created_at.getTime() + 30 * 60_000),
      },
    );
    return { status: 'succeeded' };
  };

export function buildCuratorActivityHandler(db: Db) {
  return async (jobs: Job<{ source_id: string }>[]) => {
    for (const job of jobs) {
      const [latest] = await db
        .select({ id: event.id, created_at: event.created_at })
        .from(event)
        .where(inArray(event.action, CURATOR_ACTIVITY_ACTIONS))
        .orderBy(desc(event.created_at), desc(event.id))
        .limit(1);
      if (!latest || latest.id !== job.data.source_id) continue;
      if (Date.now() < latest.created_at.getTime() + 30 * 60_000)
        throw new Error('Curator activity debounce not elapsed');
      await runCurator(db, 'activity');
    }
  };
}
