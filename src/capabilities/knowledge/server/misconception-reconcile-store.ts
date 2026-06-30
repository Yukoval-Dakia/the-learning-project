// YUK-531 (A5 S4 / ADR-0036 RT1) — misconception_edge 写入期调和环的 AUDIT / PROVENANCE
// 数据层. The HETEROGENEOUS-edge analog of edge-reconcile-store.ts.
//
// misconception_reconciliation_log records SUPERSEDE / KEEP_BOTH decisions for the
// misconception ring. The misconception ring is IMPERATIVE (archiveMisconceptionEdge
// soft-archive + createMisconceptionEdge upsert), NOT event-sourced / fold-replayed —
// misconception has no fold/projection. So this table is a decision AUDIT (planned_at
// → applied_at in the same apply tx), never a write-ahead replay cursor: the whole
// apply runs in one db.transaction, so a crash rolls the log rows back too. Dedup of
// repeat candidate edges is the DB unique index on misconception_edge, not a
// deterministic id. SEPARATE table from edge_reconciliation_log (结构轴 knowledge edge)
// and memory_reconciliation_log (个性化轴) — same shape family, orthogonal domains.

import { eq } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { misconception_reconciliation_log } from '@/db/schema';

type DbLike = Db | Tx;

export type MisconceptionReconcileLogAction = 'KEEP_BOTH' | 'SUPERSEDE';

/** A planned audit row: one per misconception-edge reconcile decision. */
export type MisconceptionPlannedRow = {
  id: string;
  candidate_from_kind: string;
  candidate_from_id: string;
  candidate_to_kind: string;
  candidate_to_id: string;
  candidate_relation_type: string;
  action: MisconceptionReconcileLogAction;
  superseded_edge_id: string | null;
  confidence: number;
  reason: string;
  llm_raw: unknown;
  planned_at: Date;
};

/** Build the candidate-edge dedup key (mirrors misconception_edge unique-index tuple). */
export function misconceptionReconcileKey(
  fromKind: string,
  fromId: string,
  toKind: string,
  toId: string,
  relationType: string,
): string {
  return `${fromKind}|${fromId}|${toKind}|${toId}|${relationType}`;
}

/**
 * Batch INSERT planned rows into misconception_reconciliation_log. applied_at left
 * NULL — stamped by markMisconceptionReconcileApplied at the end of the SAME apply
 * transaction. Audit record, not a replay cursor: the whole apply is one tx, so a
 * crash rolls these rows back too.
 */
export async function insertMisconceptionPlannedRows(
  db: DbLike,
  rows: MisconceptionPlannedRow[],
): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(misconception_reconciliation_log).values(
    rows.map((r) => ({
      id: r.id,
      candidate_from_kind: r.candidate_from_kind,
      candidate_from_id: r.candidate_from_id,
      candidate_to_kind: r.candidate_to_kind,
      candidate_to_id: r.candidate_to_id,
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
 * UPDATE applied_at = now() — stamps the audit row as fully applied (same tx).
 *
 * Mirrors markEdgeReconcileApplied: verify the UPDATE actually hit a row via
 * `.returning({ id })` and throw if it is not exactly one, so the enclosing single
 * apply transaction rolls back (fail loud, never a silent planned-but-unapplied row).
 */
export async function markMisconceptionReconcileApplied(db: DbLike, logId: string): Promise<void> {
  const updated = await db
    .update(misconception_reconciliation_log)
    .set({ applied_at: new Date() })
    .where(eq(misconception_reconciliation_log.id, logId))
    .returning({ id: misconception_reconciliation_log.id });
  if (updated.length !== 1) {
    throw new Error(
      `markMisconceptionReconcileApplied: expected to stamp exactly 1 misconception_reconciliation_log row for id=${logId}, updated ${updated.length}`,
    );
  }
}

/** Build a planned row with a fresh cuid2 id (convenience for the handler). */
export function makeMisconceptionPlannedRow(
  opts: Omit<MisconceptionPlannedRow, 'id' | 'planned_at'>,
): MisconceptionPlannedRow {
  return {
    ...opts,
    id: newId(),
    planned_at: new Date(),
  };
}
