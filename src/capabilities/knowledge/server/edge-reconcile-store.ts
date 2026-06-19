// ADR-0034 §3 / YUK-344 调和环增量 2 — 知识边写入期调和环的 AUDIT / PROVENANCE 数据层。
//
// edge_reconciliation_log 是结构轴 SUPERSEDE 决策的审计 / 来由记录（不是 write-ahead
// replay 游标）：insertEdgePlannedRows 落 planned 行、markEdgeReconcileApplied 在同一
// apply 事务里盖 applied_at。整段 apply 跑在单个 db.transaction（propose_edge.ts
// applyEdgeSupersede）里——崩溃整体回滚（连 log 行一起），没有半途状态可重放。
// 防双写靠 knowledge_edge UNIQUE(from,to,relation_type) 约束（重复候选在 apply 前就
// skipped_duplicate_edge），不靠确定性 id。作用对象是 edge_reconciliation_log（结构轴）
// 而非 memory_reconciliation_log（个性化轴）—— OWNER RULING：另立新表、不复用 memory 表、
// 无 user_id 哨兵（结构轴 ⊥ 记忆轴）。
//
// 调和层动作空间是 KEEP_BOTH | SUPERSEDE（结构边二动作，edge-reconcile.ts），
// 不套 memory 侧四值。SUPERSEDE 的实际移除是 knowledge_edge.archived_at 软归档
// （ADR-0034 §4 load-bearing 移除）；本表只是决策审计 + 来由。

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

/**
 * Batch INSERT planned rows into edge_reconciliation_log. applied_at left NULL —
 * stamped by markEdgeReconcileApplied at the end of the SAME apply transaction
 * (archive old + write new edge + correction event). Audit record, not a replay
 * cursor: the whole apply is one tx, so a crash rolls these rows back too.
 */
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

/** UPDATE applied_at = now() — stamps the audit row as fully applied (same tx). */
export async function markEdgeReconcileApplied(db: DbLike, logId: string): Promise<void> {
  await db
    .update(edge_reconciliation_log)
    .set({ applied_at: new Date() })
    .where(eq(edge_reconciliation_log.id, logId));
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
