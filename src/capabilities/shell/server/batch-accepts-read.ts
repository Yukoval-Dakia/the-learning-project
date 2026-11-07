import { desc, eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import { PROPOSAL_BATCH_ACCEPT_ACTION } from '@/kernel/proposals/batch-confirm';

const BATCH_ACCEPT_LIST_LIMIT = 20;

/**
 * Recent batch-confirm anchors. The anchor is the durable `batch_id ->
 * proposal_ids` mapping written by the batch-accept lane; the inbox offers
 * revoke-by-batch through the canonical per-item retract path using these ids.
 */
export async function listProposalBatchAccepts(db: Db) {
  const rows = await db
    .select({
      subject_id: event.subject_id,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(eq(event.action, PROPOSAL_BATCH_ACCEPT_ACTION))
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(BATCH_ACCEPT_LIST_LIMIT);
  return {
    batches: rows.map((row) => ({
      batch_id: row.subject_id,
      proposal_ids: Array.isArray(row.payload.proposal_ids) ? row.payload.proposal_ids : [],
      items: Array.isArray(row.payload.items) ? row.payload.items : [],
      created_at: row.created_at.toISOString(),
    })),
  };
}
