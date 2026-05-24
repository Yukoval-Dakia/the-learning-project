// YUK-15 — record ↔ proposal evidence loop.
//
// When a learning_record is referenced as evidence in an AI proposal, its
// processing_status flips: raw → linked (at proposal write), linked → actioned
// (at accept), actioned → linked (at retract). Archived rows are never touched.
//
// All helpers accept `DbLike = Db | Tx` so callers can opt into transaction
// sharing (writeAiProposal pulls record-flip into the same tx as the propose
// event for atomicity). Accept/retract paths run outside an outer tx — they
// already committed the rate/correction event before invoking us, so the
// record-flip is a best-effort follow-up.

import type { AiProposalPayloadT, ProposalEvidenceRefT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { event, learning_record } from '@/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

type DbLike = Db | Tx;

/**
 * Filter evidence_refs down to record IDs (deduped). Used by writer + accept +
 * retract paths to extract the records to flip.
 */
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
  fromStatuses: string[],
  to: 'linked' | 'actioned' | 'raw',
): Promise<number> {
  if (ids.length === 0) return 0;
  const now = new Date();
  const rows = await db
    .update(learning_record)
    .set({ processing_status: to, updated_at: now })
    .where(
      and(
        inArray(learning_record.id, ids),
        inArray(learning_record.processing_status, fromStatuses),
        isNull(learning_record.archived_at),
      ),
    )
    .returning({ id: learning_record.id });
  return rows.length;
}

/**
 * Flip records from `raw` → `linked`. Called by writeAiProposal in the same tx
 * as the propose event so the projection stays consistent.
 *
 * Already-`linked` / `actioned` records are left alone (idempotent: rewriting
 * the same evidence_refs across proposals does not reset progress).
 */
export async function markRecordsLinked(db: DbLike, ids: string[]): Promise<number> {
  return await bulkSetStatus(db, ids, ['raw'], 'linked');
}

/**
 * Flip records from `linked` / `raw` → `actioned`. Called by acceptAiProposal
 * after the kind-specific owner service materialized.
 *
 * `raw` is included to be defensive: if a producer somehow bypassed
 * writeAiProposal's flip (legacy data, manual events) the accept still wins.
 */
export async function markRecordsActioned(db: DbLike, ids: string[]): Promise<number> {
  return await bulkSetStatus(db, ids, ['raw', 'linked'], 'actioned');
}

/**
 * Flip records from `actioned` → `linked` on retract. We do NOT roll all the
 * way back to `raw`; the record may still be evidence for other active
 * proposals, and the more conservative "linked" state preserves that signal.
 *
 * Follow-up B (see plan): if product wants full rollback to `raw`, need a
 * dedup query against remaining propose events.
 */
export async function rollbackRecordsActioned(db: DbLike, ids: string[]): Promise<number> {
  return await bulkSetStatus(db, ids, ['actioned'], 'linked');
}

/**
 * Reverse query: given a list of record IDs, count how many active (non-rated)
 * propose events reference each. Used by /api/records to surface
 * "已产生 N 条 AI 提议" on the record card.
 *
 * Counts include accepted + dismissed + pending proposals (anything that ever
 * cited the record). Retracted proposals (action='correct', correction_kind=
 * 'retract') are NOT subtracted here — they remain countable as historical
 * evidence trail; the per-record UI can fetch full history if needed.
 *
 * Naive JSONB scan via `@>` is fine: propose event table is small (single user)
 * and the predicate is index-friendly via the existing GIN on payload.
 */
export async function getProposalCountsForRecords(
  db: DbLike,
  ids: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const id of ids) counts.set(id, 0);
  if (ids.length === 0) return counts;

  // Single SQL scan: pull all propose / experimental:propose_* / experimental:
  // proposal / experimental:knowledge_% rows and count occurrences of each
  // record id in payload.ai_proposal.evidence_refs.
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
