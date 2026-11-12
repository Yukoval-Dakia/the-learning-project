import { type SQL, and, asc, eq, gt, inArray, lte, notInArray } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
import { learnerEvidenceSql } from '../server/memory/learner-evidence';
import { CURATOR_ACTIVITY_ACTIONS } from './activity-contract';
import { gradedOutcomesForAnswerRows } from './answer-outcome';
import { readTopics, withdrawnTopicEvidence } from './topics';

// The run anchor freezes the upper bound. Later user turns never become implicit
// evidence for a Curator run already in flight. Synchronous edits are already
// reflected in the projection; replaying their requests would undo a later undo.
//
// The one owner of the evidence-window rule: derivation policy ∩ learner
// evidence ∩ user actor ∩ activity/goal actions ∩ withdrawal exclusion ∩
// (as_of, anchor] window. Any read that must stay inside that window composes
// this scope instead of restating the clauses.
export async function curatorEvidenceScope(db: Db | Tx, anchorId?: string): Promise<SQL> {
  if (!anchorId) throw new Error('Curator run anchor missing');
  const [anchor] = await db
    .select({ at: event.created_at })
    .from(event)
    .where(eq(event.id, anchorId));
  if (!anchor) throw new Error('Curator run anchor unknown');
  const { digest } = await readTopics(db);
  return and(
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
  ) as SQL;
}

export async function readCuratorEvidence(db: Db, anchorId?: string) {
  const scope = await curatorEvidenceScope(db, anchorId);
  const rows = await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      payload: event.payload,
      at: event.created_at,
    })
    .from(event)
    .where(scope)
    .orderBy(asc(event.created_at), asc(event.id));
  const graded = await gradedOutcomesForAnswerRows(db, rows);
  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    payload: row.payload,
    at: row.at,
    ...(graded.has(row.id) ? { outcome: graded.get(row.id) ?? null } : {}),
  }));
}

/**
 * How far a run's watermark may move given what the model actually read.
 * `rows` is the evidence window ascending; `readIds` holds ids `query_events`
 * returned during the run — index excerpts are discovery, not reads, and never
 * retire the watermark. The advance is the instant just before the oldest
 * unread row: the read prefix retires, the unread row and everything after
 * stay in the next window. Null when nothing is retired; `now` on full reads.
 */
export function curatorWatermarkAdvance(
  rows: { id: string; at: Date }[],
  readIds: ReadonlySet<string>,
  now: Date,
): Date | null {
  const firstUnread = rows.find((row) => !readIds.has(row.id));
  if (!firstUnread) return now;
  const coveredPrefixEnd = new Date(firstUnread.at.getTime() - 1);
  return coveredPrefixEnd >= rows[0].at ? coveredPrefixEnd : null;
}

/** Coverage receipt for a run's scan event: listed in the index vs read. */
export function curatorEvidenceCoverage(
  rows: { id: string; at: Date }[],
  readIds: ReadonlySet<string>,
  listedIds: ReadonlySet<string>,
) {
  const firstUnread = rows.find((row) => !readIds.has(row.id));
  return {
    window_events: rows.length,
    listed_events: rows.filter((row) => listedIds.has(row.id)).length,
    read_events: rows.filter((row) => readIds.has(row.id)).length,
    complete: firstUnread === undefined,
    first_unread_at: firstUnread?.at.toISOString() ?? null,
  };
}

export async function readCuratorLegacyScopes(db: Db) {
  const { memory_brief_note } = await import('@/db/schema');
  const { readMemoryBriefNote } = await import('./memory-brief');
  const rows = await db.select({ key: memory_brief_note.scope_key }).from(memory_brief_note);
  const { digest, version } = await readTopics(db);
  const withheld = withdrawnTopicEvidence(digest);
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
          ...(ids.some((id) => withheld.has(id)) || version !== read.version
            ? { withheld: true }
            : {}),
        };
      }),
  );
}
