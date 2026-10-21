import { eq, isNull, sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { memory_reconciliation_log } from '@/db/schema';
import type { MemoryClient } from './client';

// Write-ahead reconcile log for mem0. Self-built: the reconciliation log is
// drizzle-managed, while the mem0 pgvector collection is addressed by raw SQL.

export type ReconcileAction = 'KEEP_BOTH' | 'SUPERSEDE' | 'MERGE' | 'RETRACT_NEW';

// The collection name is interpolated raw into a table identifier. Callers pass
// config or test constants today, but guard the interpolation so it cannot become
// a SQL-injection vector; quoting alone does not neutralize a name containing `"`.
function assertSafeCollectionName(name: string): void {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error(`Unsafe mem0 collection name for raw SQL: ${JSON.stringify(name)}`);
  }
}

/** A planned write-ahead row: one per LLM decision. */
export type PlannedRow = {
  id: string;
  user_id: string;
  new_memory_id: string | null;
  old_memory_id: string | null;
  action: ReconcileAction;
  reason: string;
  llm_raw: unknown;
  planned_at: Date;
  // Write-ahead undo snapshot. Only KEEP_BOTH may omit it (no undo target); every
  // destructive row must carry prev_text, the recovery floor. For MERGE it is the
  // only source of the old row's text. Captured before any mutation, never at
  // apply time, so a replay cannot read already-rewritten payload.
  prev_text?: string | null;
  prev_metadata?: Record<string, unknown> | null;
};

/** Insert planned rows with applied_at NULL; markApplied runs after the apply step. */
export async function insertPlannedRows(db: Db, rows: PlannedRow[]): Promise<void> {
  if (rows.length === 0) return;
  // Every destructive row must carry its undo snapshot. Fail closed before any
  // insert: nothing has been destroyed yet, so a missing snapshot is a synthesis
  // bug, not a data-loss case to swallow.
  for (const r of rows) {
    if (r.action !== 'KEEP_BOTH' && r.prev_text == null) {
      throw new Error(
        `[memory_reconcile] destructive planned row without prev_text snapshot: action=${r.action} id=${r.id} user=${r.user_id}`,
      );
    }
  }
  await db.insert(memory_reconciliation_log).values(
    rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      new_memory_id: r.new_memory_id,
      old_memory_id: r.old_memory_id,
      action: r.action,
      reason: r.reason,
      llm_raw: r.llm_raw as Record<string, unknown> | null,
      planned_at: r.planned_at,
      // Explicit column map: the undo columns must be listed or they silently drop
      // (and audit:schema fails). Undefined → NULL for pre-snapshot callers.
      prev_text: r.prev_text ?? null,
      prev_metadata: r.prev_metadata ?? null,
    })),
  );
}

/**
 * Soft-supersede a mem0 vector row by merging superseded_by / invalid_at /
 * created_ms into its jsonb payload. The jsonb merge preserves existing keys.
 * superseded_by is never JSON null: the read filter checks for a present key.
 */
export async function softSupersede(
  db: Db,
  collectionName: string,
  opts: {
    oldMemoryId: string; // mem0 vector row id (uuid PK)
    supersededByNewId: string; // the new memory that replaces it
    invalidAtMs: number; // epoch-ms when invalidated
    createdMs: number; // epoch-ms of the new memory (for recency alignment)
  },
): Promise<void> {
  assertSafeCollectionName(collectionName);
  const invalidAtIso = new Date(opts.invalidAtMs).toISOString();
  await db.execute(
    sql`UPDATE ${sql.raw(`"${collectionName}"`)}
        SET payload = payload || jsonb_build_object(
          'superseded_by', ${opts.supersededByNewId}::text,
          'invalid_at',    ${invalidAtIso}::text,
          'created_ms',    ${String(opts.createdMs)}::text
        )
        WHERE id = ${opts.oldMemoryId}::uuid`,
  );
}

/**
 * Rewrite the surviving memory's text in place for MERGE. The old row stays live;
 * only payload data and created_ms change, never superseded_by/invalid_at (those
 * markers would make the survivor vanish from reads). Known limitation: this does
 * not re-embed, so vector search still reflects the pre-merge text.
 */
export async function rewriteMemoryText(
  db: Db,
  collectionName: string,
  opts: {
    memoryId: string;
    mergedText: string;
    createdMs: number;
  },
): Promise<void> {
  assertSafeCollectionName(collectionName);
  await db.execute(
    sql`UPDATE ${sql.raw(`"${collectionName}"`)}
        SET payload = payload || jsonb_build_object(
          'data',       ${opts.mergedText}::text,
          'created_ms', ${String(opts.createdMs)}::text
        )
        WHERE id = ${opts.memoryId}::uuid`,
  );
}

/**
 * Physically delete a mem0 row via the official delete(), which writes a SQLite
 * history tombstone before the vector delete. The WAL prev_text remains the
 * primary undo source; "not found" idempotency lives in client.hardDelete.
 */
export async function hardDeleteMemory(
  client: Pick<MemoryClient, 'hardDelete'>,
  memoryId: string,
): Promise<void> {
  await client.hardDelete(memoryId);
}

/**
 * Read-only snapshot of a mem0 row's current payload, taken in the write-ahead
 * phase so the undo log holds pre-change state. Missing row → null; the caller
 * then relies on prev_text. Never call at apply time: a crash replay would
 * snapshot the already-rewritten payload.
 */
export async function capturePrevState(
  db: Db,
  collectionName: string,
  memoryId: string,
): Promise<{ text: string | null; metadata: Record<string, unknown> } | null> {
  assertSafeCollectionName(collectionName);
  const rows = (await db.execute(
    sql`SELECT payload FROM ${sql.raw(`"${collectionName}"`)} WHERE id = ${memoryId}::uuid`,
  )) as Array<{ payload: Record<string, unknown> }>;
  const payload = rows[0]?.payload;
  if (!payload) return null;
  const text = typeof payload.data === 'string' ? payload.data : null;
  return { text, metadata: payload };
}

/** Mark a write-ahead row as fully applied. */
export async function markApplied(db: Db, logId: string): Promise<void> {
  await db
    .update(memory_reconciliation_log)
    .set({ applied_at: new Date() })
    .where(eq(memory_reconciliation_log.id, logId));
}

/**
 * Idempotent replay cursor: planned rows not yet applied for this user. Runs at
 * the start of every reconcile job so a crash mid-apply resumes rather than lost.
 *
 * Not row-locked. Serialization relies on the per-user singleton key and a single
 * batchSize:1 worker. If jobs still overlap, the apply step itself is idempotent
 * (jsonb merge, hardDelete treats absence as success, markApplied is once-only).
 */
export async function loadUnappliedLog(db: Db, userId: string): Promise<PlannedRow[]> {
  // Deliberately excludes the undo snapshot: apply never reads it (recovery is an
  // offline query), so pulling it would waste bytes on every replay.
  const rows = await db
    .select({
      id: memory_reconciliation_log.id,
      user_id: memory_reconciliation_log.user_id,
      new_memory_id: memory_reconciliation_log.new_memory_id,
      old_memory_id: memory_reconciliation_log.old_memory_id,
      action: memory_reconciliation_log.action,
      reason: memory_reconciliation_log.reason,
      llm_raw: memory_reconciliation_log.llm_raw,
      planned_at: memory_reconciliation_log.planned_at,
    })
    .from(memory_reconciliation_log)
    .where(
      sql`${memory_reconciliation_log.user_id} = ${userId}
          AND ${isNull(memory_reconciliation_log.applied_at)}`,
    )
    .orderBy(memory_reconciliation_log.planned_at);
  return rows.map((r) => ({
    id: r.id,
    user_id: r.user_id,
    new_memory_id: r.new_memory_id,
    old_memory_id: r.old_memory_id,
    action: r.action as ReconcileAction,
    reason: r.reason,
    llm_raw: r.llm_raw,
    planned_at: r.planned_at,
  }));
}

/** Build a planned row with a fresh id. */
export function makePlannedRow(opts: Omit<PlannedRow, 'id' | 'planned_at'>): PlannedRow {
  return {
    ...opts,
    id: newId(),
    planned_at: new Date(),
  };
}
