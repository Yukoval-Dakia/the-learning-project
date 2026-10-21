// record ↔ proposal evidence loop: raw → linked at proposal write, linked/raw
// → actioned at accept, actioned → linked at retract. Archived rows are untouched.
// Accept/retract run after their event committed, so the flip is best-effort.

import { sql } from 'drizzle-orm';
import type { AiProposalPayloadT, ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { transitionLearningRecords } from './queries';
import type { LearningRecordProcessingStatus } from './types';

type DbLike = Db | Tx;

/** Record ids in evidence_refs, deduped. */
export function extractRecordEvidenceIds(refs: readonly ProposalEvidenceRefT[]): string[] {
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === 'record') ids.add(ref.id);
  }
  return [...ids];
}

async function bulkSetStatus(
  db: DbLike,
  ids: string[],
  fromStatuses: readonly LearningRecordProcessingStatus[],
  to: LearningRecordProcessingStatus,
): Promise<number> {
  return await transitionLearningRecords(db, ids, fromStatuses, to);
}

/**
 * Flip raw → linked in the proposal writer's transaction. Already linked/actioned
 * rows are left alone, so replaying the same evidence does not reset progress.
 */
export async function markRecordsLinked(db: DbLike, ids: string[]): Promise<number> {
  return await bulkSetStatus(db, ids, ['raw'], 'linked');
}

/**
 * Flip linked/raw → actioned after the owner service materializes. raw is included
 * so legacy or manually written evidence still reaches the accepted state.
 */
export async function markRecordsActioned(db: DbLike, ids: string[]): Promise<number> {
  return await bulkSetStatus(db, ids, ['raw', 'linked'], 'actioned');
}

/**
 * Flip actioned → linked on retract, not back to raw: the record may still be
 * evidence for another active proposal.
 */
export async function rollbackRecordsActioned(db: DbLike, ids: string[]): Promise<number> {
  return await bulkSetStatus(db, ids, ['actioned'], 'linked');
}

/**
 * Count proposals citing each record for the record card. Retractions are not
 * subtracted: they remain part of the historical evidence trail.
 */
export async function getProposalCountsForRecords(
  db: DbLike,
  ids: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, 0);
  if (ids.length === 0) return counts;

  const rows = await db
    .select({
      id: event.id,
      payload: event.payload,
    })
    .from(event)
    .where(
      sql`(${event.action} = 'propose'
            OR ${event.action} = 'experimental:proposal'
            OR ${event.action} = 'experimental:propose_learning_intent'
            OR ${event.action} LIKE 'experimental:knowledge_%')
          AND ${event.payload}->'ai_proposal' IS NOT NULL`,
    );

  for (const row of rows) {
    const aiProposal = (row.payload as { ai_proposal?: Partial<AiProposalPayloadT> }).ai_proposal;
    const refs = aiProposal?.evidence_refs;
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (ref && ref.kind === 'record' && typeof ref.id === 'string' && counts.has(ref.id)) {
        counts.set(ref.id, (counts.get(ref.id) ?? 0) + 1);
      }
    }
  }
  return counts;
}
