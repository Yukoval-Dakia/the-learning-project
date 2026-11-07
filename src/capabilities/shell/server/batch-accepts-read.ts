import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { PROPOSAL_BATCH_ACCEPT_ACTION } from '@/kernel/proposals/batch-confirm';

const BATCH_ACCEPT_LIST_LIMIT = 20;

interface BatchAnchorPayload {
  stage?: unknown;
  proposal_ids?: unknown;
  items?: unknown;
}

/**
 * Recent batch-confirm anchors folded per batch: `members` records the
 * requested set (written before the first effect), `result` records the
 * accepted set and per-item outcomes for revoke-by-batch through the
 * canonical per-item retract path. A batch stuck at `open` had accepts
 * committed but no result recorded — the retry that completes it writes
 * `closed`. Multiple result anchors may exist when a retry accepted members
 * the first run could not; `proposal_ids` is their union.
 */
export async function listProposalBatchAccepts(db: Db) {
  const rows = await db
    .select({
      subject_id: event.subject_id,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(
      and(eq(event.action, PROPOSAL_BATCH_ACCEPT_ACTION), eq(event.subject_kind, 'proposal_batch')),
    )
    .orderBy(desc(event.created_at), desc(event.id));

  const byBatch = new Map<
    string,
    {
      batch_id: string;
      state: 'open' | 'closed';
      member_ids: string[];
      accepted: Set<string>;
      items: unknown[];
      created_at: string;
    }
  >();
  for (const row of rows) {
    const payload = row.payload as BatchAnchorPayload;
    const stage = payload.stage ?? 'result';
    const batchId = row.subject_id;
    const existing = byBatch.get(batchId) ?? {
      batch_id: batchId,
      state: 'open' as const,
      member_ids: [] as string[],
      accepted: new Set<string>(),
      items: [] as unknown[],
      created_at: row.created_at.toISOString(),
    };
    const ids = Array.isArray(payload.proposal_ids) ? (payload.proposal_ids as string[]) : [];
    if (stage === 'members') {
      existing.member_ids = ids;
      existing.created_at = row.created_at.toISOString();
    } else {
      // Rows arrive newest-first: the first result anchor seen carries the
      // latest items report; every anchor's accepted ids join the union.
      existing.state = 'closed';
      for (const id of ids) existing.accepted.add(id);
      if (existing.items.length === 0 && Array.isArray(payload.items)) {
        existing.items = payload.items;
      }
    }
    byBatch.set(batchId, existing);
  }
  return {
    batches: [...byBatch.values()].slice(0, BATCH_ACCEPT_LIST_LIMIT).map((batch) => ({
      batch_id: batch.batch_id,
      state: batch.state,
      member_ids: batch.member_ids.length > 0 ? batch.member_ids : [...batch.accepted].sort(),
      proposal_ids: [...batch.accepted].sort(),
      items: batch.items,
      created_at: batch.created_at,
    })),
  };
}
