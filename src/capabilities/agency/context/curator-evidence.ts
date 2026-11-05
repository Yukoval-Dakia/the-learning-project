import { and, asc, eq, gt, inArray, lte, notInArray } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import { learnerEvidenceSql } from '../server/memory/learner-evidence';
import { CURATOR_ACTIVITY_ACTIONS } from './activity-contract';
import { readTopics, withdrawnTopicEvidence } from './topics';

// The run anchor freezes the upper bound. Later user turns never become implicit
// evidence for a Curator run already in flight. Synchronous edits are already
// reflected in the projection; replaying their requests would undo a later undo.
export async function readCuratorEvidence(db: Db, anchorId?: string) {
  if (!anchorId) throw new Error('Curator run anchor missing');
  const [anchor] = await db
    .select({ at: event.created_at })
    .from(event)
    .where(eq(event.id, anchorId));
  if (!anchor) throw new Error('Curator run anchor unknown');
  const { digest } = await readTopics(db);
  return db
    .select({ id: event.id, action: event.action, payload: event.payload, at: event.created_at })
    .from(event)
    .where(
      and(
        eventAllowsDerivationSql(),
        digest.withdrawals.some((w) => w.evidence_ids.length)
          ? notInArray(event.id, [...withdrawnTopicEvidence(digest)])
          : undefined,
        learnerEvidenceSql(),
        eq(event.actor_kind, 'user'),
        inArray(event.action, [
          ...CURATOR_ACTIVITY_ACTIONS,
          'rate',
          'experimental:goal_status_update',
          'experimental:goal_scope_update',
        ]),
        lte(event.created_at, anchor.at),
        gt(event.created_at, new Date(digest.as_of ?? anchor.at.getTime() - 30 * 86400000)),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.id));
}

export async function readCuratorLegacyScopes(db: Db) {
  const { memory_brief_note } = await import('@/db/schema');
  const { readMemoryBriefNote } = await import('./memory-brief');
  const rows = await db.select({ key: memory_brief_note.scope_key }).from(memory_brief_note);
  const withheld = withdrawnTopicEvidence((await readTopics(db)).digest);
  return Promise.all(
    rows
      .filter((r) => r.key !== 'global:digest')
      .map(async (r) => {
        const read = await readMemoryBriefNote(db, r.key);
        const ids = read.note
          ? [
              ...read.note.recent_week_evidence_ids,
              ...read.note.recent_months_evidence_ids,
              ...read.note.long_term_evidence_ids,
            ]
          : [];
        return {
          scope: r.key,
          ...read,
          ...(ids.some((id) => withheld.has(id)) ? { note: null } : {}),
        };
      }),
  );
}
