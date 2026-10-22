// Audit/provenance storage for structural edge reconciliation. This log records
// decisions; it is not a replay cursor, because the whole apply is one transaction
// and a crash rolls the log back too. Double-apply is prevented by the edge unique
// key, not by deterministic ids. The structural axis keeps its own table, separate
// from memory reconciliation, and only knows KEEP_BOTH and SUPERSEDE.

import { eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { edge_reconciliation_log } from '@/db/schema';

type DbLike = Db | Tx;

export type EdgeReconcileLogAction = 'KEEP_BOTH' | 'SUPERSEDE';

/** A planned write-ahead row: one per reconcile decision. */
export type EdgePlannedRow = {
  id: string;
  candidate_from_knowledge_id: string;
  candidate_to_knowledge_id: string;
  candidate_relation_type: string;
  action: EdgeReconcileLogAction;
  superseded_edge_id: string | null;
  confidence: number;
  reason: string;
  llm_raw: unknown;
  planned_at: Date;
};

/** Build the candidate-edge dedup key (mirrors propose_edge.ts edgeKey). */
export function edgeReconcileKey(fromId: string, toId: string, relationType: string): string {
  return `${fromId}|${toId}|${relationType}`;
}

/** Insert planned rows; applied_at is stamped at the end of the same transaction. */
export async function insertEdgePlannedRows(db: DbLike, rows: EdgePlannedRow[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(edge_reconciliation_log).values(
    rows.map((r) => ({
      id: r.id,
      candidate_from_knowledge_id: r.candidate_from_knowledge_id,
      candidate_to_knowledge_id: r.candidate_to_knowledge_id,
      candidate_relation_type: r.candidate_relation_type,
      action: r.action,
      superseded_edge_id: r.superseded_edge_id,
      confidence: r.confidence,
      reason: r.reason,
      llm_raw: r.llm_raw as Record<string, unknown> | null,
      planned_at: r.planned_at,
    })),
  );
}

/**
 * Stamp the audit row applied. Require exactly one updated row, so a bad id fails
 * the transaction instead of committing an unapplied log silently.
 */
export async function markEdgeReconcileApplied(db: DbLike, logId: string): Promise<void> {
  const updated = await db
    .update(edge_reconciliation_log)
    .set({ applied_at: new Date() })
    .where(eq(edge_reconciliation_log.id, logId))
    .returning({ id: edge_reconciliation_log.id });
  if (updated.length !== 1) {
    throw new Error(
      `markEdgeReconcileApplied: expected to stamp exactly 1 edge_reconciliation_log row for id=${logId}, updated ${updated.length}`,
    );
  }
}

/** Build a planned row with a fresh cuid2 id (convenience for the handler). */
export function makeEdgePlannedRow(
  opts: Omit<EdgePlannedRow, 'id' | 'planned_at'>,
): EdgePlannedRow {
  return {
    ...opts,
    id: newId(),
    planned_at: new Date(),
  };
}
