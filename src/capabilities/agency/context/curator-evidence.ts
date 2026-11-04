import { and, desc, eq, gt, lte } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import { learnerEvidenceSql } from '../server/memory/learner-evidence';
import { readTopics } from './topics';

// The run anchor freezes the upper bound. Later user turns never become implicit
// evidence for a Curator run already in flight.
export async function readCuratorEvidence(db: Db, anchorId?: string) {
  if (!anchorId) throw new Error('Curator run anchor missing');
  const [anchor] = await db.select({ at: event.created_at }).from(event).where(eq(event.id, anchorId));
  if (!anchor) throw new Error('Curator run anchor unknown');
  const { digest } = await readTopics(db);
  return db.select({ id: event.id, action: event.action, payload: event.payload, at: event.created_at })
    .from(event).where(and(eventAllowsDerivationSql(), learnerEvidenceSql(),
      eq(event.actor_kind, 'user'), lte(event.created_at, anchor.at),
      gt(event.created_at, new Date(digest.as_of ?? anchor.at.getTime() - 30 * 86400000))))
    .orderBy(desc(event.created_at)).limit(100);
}
